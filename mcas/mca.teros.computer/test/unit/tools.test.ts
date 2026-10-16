/**
 * Tool handlers against a fake computer: the contract the agent relies on
 * (control fence, coordinate scaling, verification wording, error codes,
 * observe modes) without a desktop. The real desktop is covered by
 * test/integration/desktop.smoke.test.ts.
 */

import { beforeEach, describe, expect, it } from "bun:test"
import { ControlLease } from "../../src/control"
import { ComputerError } from "../../src/errors"
import { buildTools, type ComputerRuntime, describeState, toScreen } from "../../src/tools"

type Call = [string, ...unknown[]]

function fakeRuntime() {
  const calls: Call[] = []
  let fieldValue = ""
  const locator = {
    click: async (opts: unknown) => calls.push(["locator.click", opts]),
    fill: async (text: string) => {
      fieldValue = text
      calls.push(["locator.fill", text])
    },
    pressSequentially: async (text: string) => {
      fieldValue += text
    },
    evaluate: async () => fieldValue,
    boundingBox: async () => ({ x: 10, y: 20, width: 100, height: 40 }),
  }
  const page = {
    url: () => "https://example.com/",
    title: async () => "Example",
    waitForLoadState: async () => undefined,
    mouse: {
      move: async (x: number, y: number) => calls.push(["mouse.move", x, y]),
      wheel: async (dx: number, dy: number) => calls.push(["mouse.wheel", dx, dy]),
    },
    getByText: () => ({ first: () => ({ waitFor: async () => undefined }) }),
  }
  const rt: ComputerRuntime = {
    scale: 1,
    control: new ControlLease(async () => undefined),
    desktop: {
      screenSize: async () => ({ width: 1280, height: 800 }),
      activeWindowTitle: async () => "Example - Chromium",
      click: async (x, y, opts) => {
        calls.push(["desktop.click", x, y, opts])
      },
      typeText: async (t) => {
        calls.push(["desktop.type", t])
      },
      pressKeys: async (k) => {
        calls.push(["desktop.keys", k])
      },
      scroll: async (x, y, d, a) => {
        calls.push(["desktop.scroll", x, y, d, a])
      },
      drag: async (...a) => {
        calls.push(["desktop.drag", ...a])
      },
    },
    browser: {
      isRunning: async () => true,
      launch: async () => undefined,
      shutdown: async () => undefined,
      activePage: async () => page as never,
      tabs: async () => [{ index: 0, title: "Example", url: "https://example.com/", active: true }],
      switchTab: async () => page as never,
      closeTab: async () => undefined,
      newTab: async () => page as never,
      goto: async (_p, url) => {
        calls.push(["goto", url])
      },
      snapshot: async () => '- link "More" [ref=e3]',
      locate: async (_p, ref) => {
        if (ref === "e404")
          throw new ComputerError("element_not_found", `ref ${ref} is not on the page anymore`)
        return locator as never
      },
    },
    screenshot: async (width) => {
      rt.scale = 1280 / width
      return {
        url: "http://files.test/media/1",
        width,
        height: Math.round((800 * width) / 1280),
        scale: rt.scale,
      }
    },
    runCommand: async (command) => ({
      stdout: `ran ${command}`,
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }),
  }
  const tools = Object.fromEntries(buildTools(rt).map((t) => [t.name, t.config.handler]))
  const call = (name: string, args: Record<string, unknown> = {}) =>
    tools[name](args, {} as never) as Promise<{ output: string; attachments?: unknown[] }>
  return { rt, calls, call }
}

let f: ReturnType<typeof fakeRuntime>
beforeEach(() => {
  f = fakeRuntime()
})

describe("control fence", () => {
  it("input tools fail with human_has_control while a person holds control", async () => {
    await f.rt.control.takeOver("user_1", "Ana")
    for (const [tool, args] of [
      ["click", { x: 1, y: 1 }],
      ["type-text", { text: "x" }],
      ["press-key", { keys: "Enter" }],
      ["scroll", { direction: "down" }],
      ["open-url", { url: "example.com" }],
      ["run-command", { command: "ls" }],
    ] as const) {
      await expect(f.call(tool, args)).rejects.toThrow(/^human_has_control/)
    }
    expect(f.calls.filter(([c]) => c.startsWith("desktop.") || c === "goto")).toEqual([])
  })

  it("looking stays allowed while a person holds control", async () => {
    await f.rt.control.takeOver("user_1", "Ana")
    const state = await f.call("get-state")
    expect(state.output).toContain("Control: HUMAN (Ana")
    const shot = await f.call("screenshot")
    expect(shot.attachments).toHaveLength(1)
  })
})

describe("coordinates", () => {
  it("are screenshot pixels, scaled to the screen after a downscaled screenshot", async () => {
    await f.call("screenshot", { width: 640 })
    await f.call("click", { x: 100, y: 50, observe: "none" })
    expect(f.calls.find(([c]) => c === "desktop.click")).toEqual([
      "desktop.click",
      200,
      100,
      expect.anything(),
    ])
  })

  it("outside the screen is invalid_argument", async () => {
    await expect(toScreen(f.rt, 5000, 10)).rejects.toThrow(/^invalid_argument/)
  })

  it("click needs a ref or both x and y", async () => {
    await expect(f.call("click", { x: 3 })).rejects.toThrow(/^invalid_argument: pass ref/)
  })
})

describe("verification wording", () => {
  it("type-text with ref reads the field back: verified", async () => {
    const r = await f.call("type-text", { ref: "e5", text: "Ada", observe: "none" })
    expect(r.output).toContain("Verification: verified")
  })

  it("type-text without ref is synthetic input: unverified", async () => {
    const r = await f.call("type-text", { text: "Ada", observe: "none" })
    expect(r.output).toContain("unverified (synthetic input)")
    expect(f.calls).toContainEqual(["desktop.type", "Ada"])
  })

  it("ref click is delivered, coordinate click is unverified", async () => {
    expect((await f.call("click", { ref: "e3", observe: "none" })).output).toContain("delivered")
    expect((await f.call("click", { x: 1, y: 1, observe: "none" })).output).toContain(
      "unverified (synthetic input)",
    )
  })

  it("a stale ref surfaces element_not_found", async () => {
    await expect(f.call("click", { ref: "e404" })).rejects.toThrow(/^element_not_found/)
  })
})

describe("observe modes", () => {
  it("snapshot (default) includes refs, summary does not, none returns only the action line", async () => {
    expect((await f.call("press-key", { keys: "Tab" })).output).toContain("[ref=e3]")
    const summary = (await f.call("press-key", { keys: "Tab", observe: "summary" })).output
    expect(summary).toContain("Browser: https://example.com/")
    expect(summary).not.toContain("[ref=")
    expect((await f.call("press-key", { keys: "Tab", observe: "none" })).output).toBe(
      "Pressed Tab. Verification: unverified (synthetic input).",
    )
  })

  it("screenshot observe attaches an image", async () => {
    const r = await describeState(f.rt, "screenshot")
    expect(r.attachments).toEqual([
      { url: "http://files.test/media/1", mime: "image/jpeg", filename: "screen.jpg" },
    ])
  })

  it("rejects unknown observe values", async () => {
    await expect(f.call("press-key", { keys: "Tab", observe: "video" })).rejects.toThrow(
      /^invalid_argument/,
    )
  })
})

describe("open-url", () => {
  it("adds https:// to bare hosts", async () => {
    await f.call("open-url", { url: "example.com/path", observe: "none" })
    expect(f.calls).toContainEqual(["goto", "https://example.com/path"])
  })

  it("refuses non-http schemes", async () => {
    await expect(f.call("open-url", { url: "file:///etc/passwd" })).rejects.toThrow(
      /^invalid_argument/,
    )
    await expect(f.call("open-url", { url: "javascript:alert(1)" })).rejects.toThrow(
      /^invalid_argument/,
    )
  })
})

describe("scroll", () => {
  it("with a ref wheels inside the element (100 px per notch)", async () => {
    await f.call("scroll", { ref: "e3", direction: "down", amount: 3, observe: "none" })
    expect(f.calls).toContainEqual(["mouse.move", 60, 40])
    expect(f.calls).toContainEqual(["mouse.wheel", 0, 300])
  })

  it("without target scrolls at the screen centre", async () => {
    await f.call("scroll", { direction: "up", observe: "none" })
    expect(f.calls).toContainEqual(["desktop.scroll", 640, 400, "up", 5])
  })
})

describe("run-command", () => {
  it("returns exit code and stdout", async () => {
    const r = await f.call("run-command", { command: "ls ~" })
    expect(r.output).toBe("exit code 0\n--- stdout ---\nran ls ~")
  })
})
