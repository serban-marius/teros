import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  chromiumArgs,
  DEFAULT_RESTART_POLICY,
  DesktopBrowser,
  nextRestart,
  repairProfile,
} from "../../src/browser"

describe("repairProfile", () => {
  it("drops the singleton lock of a killed container and marks the exit clean", async () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-"))
    mkdirSync(join(dir, "Default"))
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
      writeFileSync(join(dir, f), "old-host")
    writeFileSync(
      join(dir, "Default", "Preferences"),
      JSON.stringify({ profile: { exit_type: "Crashed" }, keep: 1 }),
    )
    await repairProfile(dir)
    expect(existsSync(join(dir, "SingletonLock"))).toBe(false)
    const prefs = JSON.parse(readFileSync(join(dir, "Default", "Preferences"), "utf8"))
    expect(prefs.profile).toMatchObject({ exit_type: "Normal", exited_cleanly: true })
    expect(prefs.keep).toBe(1)
  })

  it("tolerates a fresh or corrupt profile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-"))
    await repairProfile(dir)
    mkdirSync(join(dir, "Default"))
    writeFileSync(join(dir, "Default", "Preferences"), "{not json")
    await expect(repairProfile(dir)).resolves.toBeUndefined()
  })
})

describe("chromiumArgs", () => {
  it("looks like a person’s browser: no automation switches, persistent profile, CDP on loopback", () => {
    const args = chromiumArgs("https://example.com")
    expect(args).toContain("--password-store=basic")
    expect(args).toContain("--remote-debugging-address=127.0.0.1")
    expect(args.some((a) => a.startsWith("--user-data-dir="))).toBe(true)
    expect(args.some((a) => /enable-automation|headless/.test(a))).toBe(false)
    expect(args.at(-1)).toBe("https://example.com")
  })
})

describe("nextRestart", () => {
  const p = DEFAULT_RESTART_POLICY

  it("a person closing the window brings the browser back at once", () => {
    expect(nextRestart({ code: 0, signal: null, uptimeMs: 120_000 }, 2)).toEqual({
      delayMs: p.cleanMs,
      failures: 0,
    })
  })

  it("crashes back off exponentially up to the cap", () => {
    const delays: number[] = []
    let failures = 0
    for (let i = 0; i < 8; i++) {
      const next = nextRestart({ code: null, signal: "SIGKILL", uptimeMs: 2_000 }, failures)
      delays.push(next.delayMs)
      failures = next.failures
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
  })

  it("a clean exit right after start counts as a failed start; a long run forgives the streak", () => {
    expect(nextRestart({ code: 0, signal: null, uptimeMs: 500 }, 3).failures).toBe(4)
    expect(nextRestart({ code: 1, signal: null, uptimeMs: p.stableMs }, 5)).toEqual({
      delayMs: p.baseMs,
      failures: 1,
    })
  })
})

describe("DesktopBrowser supervisor", () => {
  const policy = { cleanMs: 10, baseMs: 20, maxMs: 80, stableMs: 60_000 }

  function harness() {
    const state = { up: false, spawns: 0, children: [] as EventEmitter[] }
    const browser = new DesktopBrowser({
      policy,
      startTimeoutMs: 1_000,
      repair: async () => undefined,
      cdpUp: async () => state.up,
      log: () => undefined,
      spawnBrowser: () => {
        state.spawns++
        state.up = true
        const child = Object.assign(new EventEmitter(), { unref: () => undefined })
        state.children.push(child)
        return child
      },
    })
    /** Chromium goes away (window closed, crash, OOM kill). */
    const exit = (code: number | null, signal: string | null = null) => {
      state.up = false
      state.children.at(-1)?.emit("exit", code, signal)
    }
    return { browser, state, exit }
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it("starts the browser again whenever it exits", async () => {
    const { browser, state, exit } = harness()
    await browser.launch()
    exit(null, "SIGKILL")
    expect(browser.status()).toMatchObject({ state: "restarting", failures: 1, crashLoop: false })
    await sleep(60)
    expect(state.spawns).toBe(2)
    expect(state.up).toBe(true)
    expect(browser.status()).toEqual({ state: "running" })
  })

  it("a tool call doesn't wait for the backoff", async () => {
    const { browser, state, exit } = harness()
    await browser.launch()
    exit(1)
    await browser.launch()
    expect(state.spawns).toBe(2)
    await sleep(60)
    expect(state.spawns).toBe(2)
  })

  it("in a crash loop tools get browser_not_running with the retry time; the desktop menu forces a start", async () => {
    const { browser, state, exit } = harness()
    await browser.launch()
    for (let i = 0; i < 3; i++) {
      exit(null, "SIGSEGV")
      if (i < 2) await browser.launch()
    }
    expect(browser.status()).toMatchObject({ state: "restarting", failures: 3, crashLoop: true })
    await expect(browser.launch()).rejects.toThrow(
      /^browser_not_running: the browser crashed 3 times/,
    )
    await browser.relaunchNow()
    expect(state.spawns).toBe(4)
    expect(browser.status()).toEqual({ state: "running" })
  })

  it("never restarts after shutdown (container stop keeps its graceful path)", async () => {
    const { browser, state, exit } = harness()
    await browser.launch()
    state.up = false
    await browser.shutdown()
    exit(0)
    await sleep(60)
    expect(state.spawns).toBe(1)
    expect(browser.status()).toEqual({ state: "stopped" })
    await expect(browser.launch()).rejects.toThrow(/^browser_not_running/)
  })
})
