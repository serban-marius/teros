/**
 * Tool surface of mca.teros.computer — the single source of truth consumed by
 * index.ts (server registration) and the registry-sync test (tools.json).
 *
 * The loop it is built for (see AGENT.md): look (get-state: accessibility
 * snapshot with element refs, screenshot on demand) → act (by ref when the
 * target is in the page, by coordinates otherwise) → check the state every
 * action returns before the next step.
 */

import type { ToolConfig } from "@teros/mca-sdk"
import type { Locator, Page } from "playwright-core"
import type { BrowserStatus } from "./browser"
import type { ControlLease } from "./control"
import type { MouseButton, ScrollDirection } from "./desktop"
import { ComputerError, invalidArgument } from "./errors"
import type { ExecResult } from "./exec"
import { parseModifiers } from "./keys"

// ============================================================================
// RUNTIME (real one in index.ts, fakes in tests)
// ============================================================================

export interface DesktopLike {
  screenSize(): Promise<{ width: number; height: number }>
  activeWindowTitle(): Promise<string | null>
  click(
    x: number,
    y: number,
    opts?: { button?: MouseButton; double?: boolean; modifiers?: string },
  ): Promise<void>
  typeText(text: string): Promise<void>
  pressKeys(keys: string): Promise<void>
  scroll(x: number, y: number, direction: ScrollDirection, amount: number): Promise<void>
  drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>
}

export interface BrowserLike {
  isRunning(): Promise<boolean>
  launch(startUrl?: string): Promise<void>
  relaunchNow(): Promise<void>
  status(): BrowserStatus
  shutdown(timeoutMs?: number): Promise<void>
  activePage(autoLaunch?: boolean): Promise<Page>
  tabs(): Promise<Array<{ index: number; title: string; url: string; active: boolean }>>
  switchTab(index: number): Promise<Page>
  closeTab(index: number): Promise<void>
  newTab(url?: string): Promise<Page>
  goto(page: Page, url: string): Promise<void>
  snapshot(page: Page, maxChars: number): Promise<string>
  locate(page: Page, ref: string): Promise<Locator>
}

export interface Shot {
  url: string
  width: number
  height: number
  scale: number
}

export interface ComputerRuntime {
  desktop: DesktopLike
  browser: BrowserLike
  control: ControlLease
  screenshot(width: number, quality: number): Promise<Shot>
  runCommand(command: string, timeoutMs: number): Promise<ExecResult>
  /** Screen px per screenshot px of the latest screenshot (1 before any). */
  scale: number
}

// ============================================================================
// SHARED HELPERS
// ============================================================================

type Observe = "snapshot" | "summary" | "screenshot" | "none"
const OBSERVE_VALUES: Observe[] = ["snapshot", "summary", "screenshot", "none"]
const DEFAULT_MAX_CHARS = 12_000

interface ToolOutput {
  output: string
  attachments?: Array<{ url: string; mime: string; filename?: string }>
}

const observeParam = {
  type: "string",
  enum: OBSERVE_VALUES,
  description:
    "What to return after acting. snapshot (default): summary + accessibility snapshot with fresh refs. " +
    "summary: control/window/url only. screenshot: summary + screenshot. none: nothing.",
}

const refParam = {
  type: "string",
  description:
    'Element ref from the latest snapshot, e.g. "e12". Preferred over coordinates for anything in the web page.',
}
const xParam = {
  type: "number",
  description:
    "X in pixels of the LATEST SCREENSHOT (scaled to screen automatically). Use when there is no ref.",
}
const yParam = { type: "number", description: "Y in pixels of the latest screenshot." }

function str(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== "string") throw invalidArgument(`${name} must be a string`)
  return v
}

function num(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined
  const n = typeof v === "string" ? Number(v) : v
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) {
    throw invalidArgument(`${name} must be a number between ${min} and ${max}`)
  }
  return n
}

function observeOf(v: unknown, fallback: Observe): Observe {
  if (v === undefined || v === null) return fallback
  if (!OBSERVE_VALUES.includes(v as Observe)) {
    throw invalidArgument(`observe must be one of ${OBSERVE_VALUES.join(", ")}`)
  }
  return v as Observe
}

/** Screenshot pixels → screen pixels, clamped to the screen. */
export async function toScreen(
  rt: ComputerRuntime,
  x: number,
  y: number,
): Promise<[number, number]> {
  const { width, height } = await rt.desktop.screenSize()
  const sx = Math.round(x * rt.scale)
  const sy = Math.round(y * rt.scale)
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
    throw invalidArgument(
      `(${x}, ${y}) is outside the screen (${Math.floor(width / rt.scale)}×${Math.floor(height / rt.scale)} in screenshot pixels)`,
    )
  }
  return [sx, sy]
}

const PW_MODIFIERS: Record<string, "Control" | "Shift" | "Alt" | "Meta"> = {
  ctrl: "Control",
  shift: "Shift",
  alt: "Alt",
  super: "Meta",
}

/** Input actions run one at a time: two interleaved xdotool sequences garble each other. */
let inputQueue: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = inputQueue.then(fn, fn)
  inputQueue = next.catch(() => undefined)
  return next
}

function looksLikeBrowser(title: string | null): boolean {
  return !!title && /chromium/i.test(title)
}

/** Why there is no browser right now, and what brings it back. */
function notRunning(rt: ComputerRuntime): string {
  const status = rt.browser.status()
  if (status.state !== "restarting") return "not running (open-url starts it)"
  const secs = Math.ceil(status.inMs / 1_000)
  return status.crashLoop
    ? `not running — it crashed ${status.failures} times in a row and restarts by itself in ${secs}s`
    : "restarting (it was closed or crashed; get-state or open-url brings it back now)"
}

/**
 * The state block every tool returns: who holds control, the focused window,
 * the browser tab, and (when asked) the page snapshot and a screenshot.
 */
export async function describeState(
  rt: ComputerRuntime,
  observe: Observe,
  maxChars = DEFAULT_MAX_CHARS,
): Promise<ToolOutput> {
  if (observe === "none") return { output: "" }
  const lines: string[] = []
  const control = rt.control.get()
  lines.push(
    control.holder === "human"
      ? `Control: HUMAN (${control.displayName ?? "a person"} since ${control.since}) — look only, do not act`
      : "Control: agent (you)",
  )
  const [screen, title] = await Promise.all([
    rt.desktop.screenSize(),
    rt.desktop.activeWindowTitle(),
  ])
  lines.push(
    `Screen: ${screen.width}×${screen.height}; coordinates you pass are screenshot pixels (scale ${rt.scale.toFixed(3)})`,
  )
  lines.push(`Focused window: ${title ?? "(none — bare desktop)"}`)

  let page: Page | null = null
  if (await rt.browser.isRunning()) {
    page = await rt.browser.activePage(false).catch(() => null)
    const tabs = await rt.browser.tabs().catch(() => [])
    if (page) {
      const pageTitle = await page.title().catch(() => "")
      const idx = tabs.findIndex((t) => t.active)
      lines.push(`Browser: ${page.url()} — "${pageTitle}" (tab ${idx + 1} of ${tabs.length})`)
    }
  } else {
    lines.push(`Browser: ${notRunning(rt)}`)
  }

  if (observe === "snapshot" && page) {
    if (title && !looksLikeBrowser(title)) {
      lines.push(
        "\nNote: the focused window is not the browser (dialog or other app). The snapshot below is the page behind it; take a screenshot to see the dialog.",
      )
    }
    lines.push("\n## Page snapshot (act with ref=…; refs go stale after the page changes)")
    lines.push(await rt.browser.snapshot(page, maxChars))
  }

  const out: ToolOutput = { output: lines.join("\n") }
  if (observe === "screenshot") {
    const shot = await rt.screenshot(1024, 60)
    out.output += `\nScreenshot: ${shot.width}×${shot.height} (scale ${shot.scale.toFixed(3)}) attached.`
    out.attachments = [{ url: shot.url, mime: "image/jpeg", filename: "screen.jpg" }]
  }
  return out
}

async function withState(
  rt: ComputerRuntime,
  head: string,
  observe: Observe,
  maxChars?: number,
): Promise<ToolOutput> {
  const state = await describeState(rt, observe, maxChars)
  return {
    output: state.output ? `${head}\n\n${state.output}` : head,
    attachments: state.attachments,
  }
}

/** Let the UI react (navigation, re-render) before reading the state back. */
async function settle(page: Page | null, ms = 400): Promise<void> {
  if (page)
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined)
  await new Promise((r) => setTimeout(r, ms))
}

function normalizeUrl(raw: string): string {
  const url = raw.trim()
  if (url === "about:blank") return url
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    throw invalidArgument(`"${raw}" is not a URL`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidArgument("only http(s) URLs can be opened")
  }
  return parsed.toString()
}

// biome-ignore lint/suspicious/noExplicitAny: per-tool arg shapes are validated in the handlers
type AnyTool = ToolConfig<any, any>

export interface RegisteredTool {
  name: string
  description: string
  inputSchema: AnyTool["parameters"]
  config: AnyTool
}

function reg(name: string, config: AnyTool): RegisteredTool {
  return { name, description: config.description, inputSchema: config.parameters, config }
}

// ============================================================================
// TOOLS
// ============================================================================

/**
 * Input on this desktop: it only acts inside the agent's own computer and a
 * person can watch it in the live view, so the agent's own instance allows it
 * by default (run-command, whose effect isn't visible, keeps asking).
 */
const SANDBOXED = { sandboxedHint: true } as const

export function buildTools(rt: ComputerRuntime): RegisteredTool[] {
  const act = async <T>(fn: () => Promise<T>): Promise<T> =>
    serialized(async () => {
      rt.control.assertAgentMayAct()
      return fn()
    })

  return [
    reg("-health-check", {
      description: "Check that the desktop and browser are up.",
      parameters: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      handler: async () => {
        const screen = await rt.desktop.screenSize()
        const browser = (await rt.browser.isRunning()) ? "running" : notRunning(rt)
        return {
          output: `ok: display ${screen.width}×${screen.height}, browser ${browser}`,
        }
      },
    }),

    reg("get-state", {
      description:
        "Look at your computer: who is in control, the focused window, the browser tab and an accessibility snapshot of the page " +
        "with element refs ([ref=e12]) to use with click/type-text/scroll. Start every task with this. " +
        "Set screenshot=true when you need pixels (dialogs, canvas, images, layout).",
      parameters: {
        type: "object",
        properties: {
          screenshot: { type: "boolean", description: "Also attach a screenshot (default false)." },
          maxChars: {
            type: "number",
            description: "Max snapshot length in characters (default 12000).",
          },
        },
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const maxChars = num(args.maxChars, "maxChars", 500, 100_000) ?? DEFAULT_MAX_CHARS
        // Looking at the computer brings a closed or crashed browser back,
        // and a minimized one (bare desktop) to the front.
        await rt.browser.launch().catch(() => undefined)
        if (rt.control.get().holder === "agent" && !(await rt.desktop.activeWindowTitle())) {
          await rt.browser
            .activePage(false)
            .then((p) => p.bringToFront())
            .catch(() => undefined)
        }
        const snap = await describeState(rt, "snapshot", maxChars)
        if (args.screenshot !== true) return snap
        const shot = await describeState(rt, "screenshot")
        return {
          output: `${snap.output}\n\n${shot.output.split("\n").pop()}`,
          attachments: shot.attachments,
        }
      },
    }),

    reg("screenshot", {
      description:
        "Screenshot of the whole screen (JPEG, downscaled). Coordinates you then pass to click/scroll/drag are pixels of THIS image; " +
        "scaling to the real screen is automatic. Prefer get-state (text) when the target is in the web page.",
      parameters: {
        type: "object",
        properties: {
          width: { type: "number", description: "Image width in px, 320-1280 (default 1024)." },
          quality: { type: "number", description: "JPEG quality 20-90 (default 60)." },
        },
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const width = num(args.width, "width", 320, 1280) ?? 1024
        const quality = num(args.quality, "quality", 20, 90) ?? 60
        const shot = await rt.screenshot(width, quality)
        const summary = await describeState(rt, "summary")
        return {
          output: `Screenshot ${shot.width}×${shot.height} (scale ${shot.scale.toFixed(3)}) attached.\n${summary.output}`,
          attachments: [{ url: shot.url, mime: "image/jpeg", filename: "screen.jpg" }],
        }
      },
    }),

    reg("click", {
      description:
        "Click an element by ref (from the latest snapshot) or at x,y (pixels of the latest screenshot). " +
        "Returns the fresh state. Ref clicks are delivered to the element; coordinate clicks are synthetic input — check the returned state.",
      parameters: {
        type: "object",
        properties: {
          ref: refParam,
          x: xParam,
          y: yParam,
          button: {
            type: "string",
            enum: ["left", "middle", "right"],
            description: "Mouse button (default left).",
          },
          double: { type: "boolean", description: "Double-click." },
          modifiers: { type: "string", description: 'Held keys, e.g. "ctrl" or "ctrl+shift".' },
          observe: observeParam,
        },
      },
      annotations: SANDBOXED,
      handler: async (args) => {
        const ref = str(args.ref, "ref")
        const button = (str(args.button, "button") ?? "left") as MouseButton
        if (!["left", "middle", "right"].includes(button))
          throw invalidArgument("button must be left, middle or right")
        const modifiers = str(args.modifiers, "modifiers")
        const observe = observeOf(args.observe, "snapshot")
        return act(async () => {
          let page: Page | null = null
          let verification: string
          if (ref) {
            page = await rt.browser.activePage()
            const loc = await rt.browser.locate(page, ref)
            await loc
              .click({
                button,
                clickCount: args.double ? 2 : 1,
                modifiers: parseModifiers(modifiers).map((m) => PW_MODIFIERS[m]),
                timeout: 8_000,
              })
              .catch((e: Error) => {
                throw new ComputerError(
                  "action_timeout",
                  `could not click ${ref}: ${e.message.split("\n")[0]}`,
                )
              })
            verification = "delivered (the element received the click; effect not asserted)"
          } else {
            const x = num(args.x, "x", 0, 10_000)
            const y = num(args.y, "y", 0, 10_000)
            if (x === undefined || y === undefined)
              throw invalidArgument("pass ref, or both x and y")
            const [sx, sy] = await toScreen(rt, x, y)
            await rt.desktop.click(sx, sy, { button, double: args.double === true, modifiers })
            verification = "unverified (synthetic input)"
            if (await rt.browser.isRunning())
              page = await rt.browser.activePage(false).catch(() => null)
          }
          await settle(page)
          return withState(
            rt,
            `Clicked ${ref ?? `(${args.x}, ${args.y})`}. Verification: ${verification}.`,
            observe,
          )
        })
      },
    }),

    reg("type-text", {
      description:
        "Type text. With ref: fills that field (replacing its content unless clear=false) and reads it back (verified). " +
        "Without ref: types into whatever has keyboard focus (unverified). Never type passwords or other secrets: ask the user to take over and type them.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to type." },
          ref: refParam,
          clear: {
            type: "boolean",
            description: "With ref: replace existing content (default true).",
          },
          submit: { type: "boolean", description: "Press Enter afterwards." },
          observe: observeParam,
        },
        required: ["text"],
      },
      annotations: SANDBOXED,
      handler: async (args) => {
        const text = str(args.text, "text")
        if (text === undefined) throw invalidArgument("text is required")
        if (text.length > 20_000) throw invalidArgument("text is longer than 20000 characters")
        const ref = str(args.ref, "ref")
        const observe = observeOf(args.observe, "snapshot")
        return act(async () => {
          let page: Page | null = null
          let verification = "unverified (synthetic input)"
          if (ref) {
            page = await rt.browser.activePage()
            const loc = await rt.browser.locate(page, ref)
            try {
              if (args.clear === false) {
                await loc.click({ timeout: 8_000 })
                await loc.pressSequentially(text, { delay: 10, timeout: 60_000 })
              } else {
                await loc.fill(text, { timeout: 8_000 })
              }
            } catch (e) {
              throw new ComputerError(
                "action_timeout",
                `could not type into ${ref}: ${(e as Error).message.split("\n")[0]}`,
              )
            }
            const value = await loc
              .evaluate((el) =>
                el instanceof HTMLInputElement ||
                el instanceof HTMLTextAreaElement ||
                el instanceof HTMLSelectElement
                  ? el.value
                  : (el.textContent ?? ""),
              )
              .catch(() => null)
            verification =
              value === null
                ? "unverified (could not read the field back)"
                : value.includes(text)
                  ? "verified (field contains the text)"
                  : `MISMATCH (field now contains ${JSON.stringify(value.slice(0, 200))})`
          } else {
            await rt.desktop.typeText(text)
            if (await rt.browser.isRunning())
              page = await rt.browser.activePage(false).catch(() => null)
          }
          if (args.submit === true) await rt.desktop.pressKeys("Return")
          await settle(page, args.submit === true ? 800 : 200)
          return withState(
            rt,
            `Typed ${text.length} characters${ref ? ` into ${ref}` : ""}. Verification: ${verification}.`,
            observe,
          )
        })
      },
    }),

    reg("press-key", {
      description:
        "Press keys on the focused window: one key or chord, or several separated by spaces. " +
        'Examples: "Enter", "Escape", "Tab", "ctrl+l", "ctrl+shift+t", "ctrl+a Delete", "PageDown".',
      parameters: {
        type: "object",
        properties: {
          keys: { type: "string", description: "Key or chords, space-separated." },
          observe: observeParam,
        },
        required: ["keys"],
      },
      annotations: SANDBOXED,
      handler: async (args) => {
        const keys = str(args.keys, "keys")
        if (!keys) throw invalidArgument("keys is required")
        const observe = observeOf(args.observe, "snapshot")
        return act(async () => {
          await rt.desktop.pressKeys(keys)
          const page = (await rt.browser.isRunning())
            ? await rt.browser.activePage(false).catch(() => null)
            : null
          await settle(page, 500)
          return withState(
            rt,
            `Pressed ${keys}. Verification: unverified (synthetic input).`,
            observe,
          )
        })
      },
    }),

    reg("scroll", {
      description:
        "Scroll the page or the element under a ref / point. amount is in wheel notches (~100 px each, default 5).",
      parameters: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right"],
            description: "Scroll direction.",
          },
          amount: { type: "number", description: "Wheel notches, 1-50 (default 5)." },
          ref: refParam,
          x: xParam,
          y: yParam,
          observe: observeParam,
        },
        required: ["direction"],
      },
      annotations: SANDBOXED,
      handler: async (args) => {
        const direction = str(args.direction, "direction") as ScrollDirection
        if (!["up", "down", "left", "right"].includes(direction)) {
          throw invalidArgument("direction must be up, down, left or right")
        }
        const amount = num(args.amount, "amount", 1, 50) ?? 5
        const ref = str(args.ref, "ref")
        const observe = observeOf(args.observe, "snapshot")
        return act(async () => {
          let page: Page | null = null
          if (ref) {
            page = await rt.browser.activePage()
            const loc = await rt.browser.locate(page, ref)
            const box = await loc.boundingBox()
            if (!box) throw new ComputerError("element_not_found", `${ref} is not visible`)
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            const d = amount * 100
            const [dx, dy] = { up: [0, -d], down: [0, d], left: [-d, 0], right: [d, 0] }[direction]
            await page.mouse.wheel(dx, dy)
          } else {
            let sx: number
            let sy: number
            if (args.x !== undefined || args.y !== undefined) {
              ;[sx, sy] = await toScreen(
                rt,
                num(args.x, "x", 0, 10_000) ?? 0,
                num(args.y, "y", 0, 10_000) ?? 0,
              )
            } else {
              const screen = await rt.desktop.screenSize()
              ;[sx, sy] = [Math.round(screen.width / 2), Math.round(screen.height / 2)]
            }
            await rt.desktop.scroll(sx, sy, direction, amount)
            if (await rt.browser.isRunning())
              page = await rt.browser.activePage(false).catch(() => null)
          }
          await settle(page, 300)
          return withState(rt, `Scrolled ${direction} ${amount}.`, observe)
        })
      },
    }),

    reg("drag", {
      description:
        "Drag with the left button from one point to another (pixels of the latest screenshot).",
      parameters: {
        type: "object",
        properties: {
          fromX: { type: "number", description: "Start X." },
          fromY: { type: "number", description: "Start Y." },
          toX: { type: "number", description: "End X." },
          toY: { type: "number", description: "End Y." },
          observe: observeParam,
        },
        required: ["fromX", "fromY", "toX", "toY"],
      },
      annotations: SANDBOXED,
      handler: async (args) => {
        const observe = observeOf(args.observe, "screenshot")
        const pts = ["fromX", "fromY", "toX", "toY"].map((k) => num(args[k], k, 0, 10_000))
        if (pts.some((p) => p === undefined))
          throw invalidArgument("fromX, fromY, toX and toY are required")
        return act(async () => {
          const [fx, fy] = await toScreen(rt, pts[0] as number, pts[1] as number)
          const [tx, ty] = await toScreen(rt, pts[2] as number, pts[3] as number)
          await rt.desktop.drag(fx, fy, tx, ty)
          await settle(null, 300)
          return withState(rt, "Dragged. Verification: unverified (synthetic input).", observe)
        })
      },
    }),

    reg("open-url", {
      description:
        "Open a URL in the desktop browser (starts it if closed), in the current tab or a new one. Waits for the page to load and returns its snapshot.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: 'http(s) URL; "example.com" becomes https://example.com.',
          },
          newTab: { type: "boolean", description: "Open in a new tab (default false)." },
          observe: observeParam,
        },
        required: ["url"],
      },
      annotations: SANDBOXED,
      handler: async (args) => {
        const raw = str(args.url, "url")
        if (!raw) throw invalidArgument("url is required")
        const url = normalizeUrl(raw)
        const observe = observeOf(args.observe, "snapshot")
        return act(async () => {
          let page: Page
          if (args.newTab === true) {
            page = await rt.browser.newTab(url)
          } else {
            page = await rt.browser.activePage()
            await rt.browser.goto(page, url)
          }
          await settle(page, 300)
          return withState(
            rt,
            `Opened ${url}. Verification: verified (tab is now at ${page.url()}).`,
            observe,
          )
        })
      },
    }),

    reg("tabs", {
      description:
        "List, switch to, close or open browser tabs. Tab indexes come from action=list.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "switch", "close", "new"],
            description: "What to do (default list).",
          },
          index: { type: "number", description: "Tab index for switch/close." },
          url: { type: "string", description: "URL for action=new (optional)." },
        },
      },
      annotations: SANDBOXED,
      handler: async (args) => {
        const action = str(args.action, "action") ?? "list"
        const list = async () => {
          const tabs = await rt.browser.tabs()
          return tabs
            .map(
              (t) => `${t.active ? "*" : " "} [${t.index}] ${t.title || "(untitled)"} — ${t.url}`,
            )
            .join("\n")
        }
        if (action === "list") return { output: await list() }
        const index = num(args.index, "index", 0, 500)
        return act(async () => {
          if (action === "switch") {
            if (index === undefined) throw invalidArgument("index is required")
            await rt.browser.switchTab(index)
          } else if (action === "close") {
            if (index === undefined) throw invalidArgument("index is required")
            await rt.browser.closeTab(index)
          } else if (action === "new") {
            const url = str(args.url, "url")
            await rt.browser.newTab(url ? normalizeUrl(url) : undefined)
          } else {
            throw invalidArgument("action must be list, switch, close or new")
          }
          return { output: `Done (${action}).\n${await list()}` }
        })
      },
    }),

    reg("wait", {
      description:
        "Wait for some text to appear in the page (preferred) or for a fixed time, then return the state.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Wait until this text is visible in the page." },
          ms: { type: "number", description: "Or wait this many milliseconds (max 30000)." },
          timeoutMs: {
            type: "number",
            description: "Max wait for text (default 15000, max 60000).",
          },
          observe: observeParam,
        },
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const text = str(args.text, "text")
        const observe = observeOf(args.observe, "snapshot")
        if (text) {
          const timeout = num(args.timeoutMs, "timeoutMs", 100, 60_000) ?? 15_000
          const page = await rt.browser.activePage(false)
          await page
            .getByText(text)
            .first()
            .waitFor({ state: "visible", timeout })
            .catch(() => {
              throw new ComputerError(
                "action_timeout",
                `"${text}" did not appear within ${timeout} ms`,
              )
            })
          return withState(rt, `"${text}" is visible.`, observe)
        }
        const ms = num(args.ms, "ms", 0, 30_000) ?? 1_000
        await new Promise((r) => setTimeout(r, ms))
        return withState(rt, `Waited ${ms} ms.`, observe)
      },
    }),

    reg("run-command", {
      description:
        "Run a shell command on your computer as its user (bash, in the home directory) and get stdout/stderr. " +
        "For files (e.g. ~/Downloads), quick checks and scripts. Not root: no system package installs.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command." },
          timeoutMs: { type: "number", description: "Timeout, default 30000, max 300000." },
        },
        required: ["command"],
      },
      handler: async (args) => {
        const command = str(args.command, "command")
        if (!command) throw invalidArgument("command is required")
        const timeoutMs = num(args.timeoutMs, "timeoutMs", 1_000, 300_000) ?? 30_000
        return act(async () => {
          const r = await rt.runCommand(command, timeoutMs)
          const clip = (s: string) =>
            s.length > 20_000 ? `…(first ${s.length - 20_000} chars cut)\n${s.slice(-20_000)}` : s
          const head = r.timedOut
            ? `command_failed: timed out after ${timeoutMs} ms`
            : `exit code ${r.exitCode}`
          return {
            output: `${head}\n--- stdout ---\n${clip(r.stdout)}${r.stderr ? `\n--- stderr ---\n${clip(r.stderr)}` : ""}`,
          }
        })
      },
    }),

    reg("control-status", {
      description:
        "Who is driving this computer right now: you (agent) or a person who took over from the live view. " +
        "While a person is in control your input tools fail with human_has_control.",
      parameters: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      handler: async () => {
        const c = rt.control.get()
        return {
          output:
            c.holder === "human"
              ? `human: ${c.displayName ?? c.userId ?? "a person"} in control since ${c.since}`
              : `agent: you are in control (since ${c.since})`,
        }
      },
    }),
  ]
}
