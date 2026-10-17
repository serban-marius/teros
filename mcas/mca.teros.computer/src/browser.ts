import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { chromium, type Locator, type Page, type Browser as PwBrowser } from "playwright-core"
import { ComputerError } from "./errors"
import { DISPLAY } from "./exec"

const CDP_PORT = Number(process.env.COMPUTER_CDP_PORT || 9222)
const HOME = process.env.HOME || "/home/teros"
export const PROFILE_DIR = join(HOME, ".config", "chromium")
const CHROMIUM = process.env.COMPUTER_CHROMIUM || "chromium"

/**
 * Flags for a browser that behaves like a person's own Chromium: no
 * automation switches (sites must not see `navigator.webdriver`), a profile on
 * the persistent volume, cookies decryptable in any future container
 * (`--password-store=basic`), and no crash-restore bubble stealing focus after
 * the container was killed.
 */
export function chromiumArgs(startUrl?: string): string[] {
  return [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${CDP_PORT}`,
    "--remote-debugging-address=127.0.0.1",
    "--password-store=basic",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--disable-features=Translate,MediaRouter",
    // The profile lives on a per-agent volume: keep the HTTP cache bounded.
    "--disk-cache-size=67108864",
    "--start-maximized",
    ...(process.env.COMPUTER_CHROMIUM_NO_SANDBOX === "1" ? ["--no-sandbox", "--test-type"] : []),
    ...(startUrl ? [startUrl] : []),
  ]
}

/**
 * Make a profile left behind by a killed container usable: drop the singleton
 * lock (it names the old container's hostname, so Chromium would refuse to
 * start) and mark the last exit as clean (no "restore pages?" bubble).
 */
export async function repairProfile(profileDir = PROFILE_DIR): Promise<void> {
  for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    await rm(join(profileDir, f), { force: true })
  }
  const prefsPath = join(profileDir, "Default", "Preferences")
  if (!existsSync(prefsPath)) return
  try {
    const prefs = JSON.parse(await readFile(prefsPath, "utf8"))
    if (prefs?.profile && prefs.profile.exit_type !== "Normal") {
      prefs.profile.exit_type = "Normal"
      prefs.profile.exited_cleanly = true
      await writeFile(prefsPath, JSON.stringify(prefs))
    }
  } catch {
    /* intentional: a corrupt Preferences file is Chromium's to repair; never block startup */
  }
}

export interface TabInfo {
  index: number
  title: string
  url: string
  active: boolean
}

export interface BrowserProcess {
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown
  unref(): void
}

export interface RestartPolicy {
  /** After a deliberate close (clean exit of a browser that was up). */
  cleanMs: number
  /** First delay after a crash or a failed start; doubles per failure. */
  baseMs: number
  maxMs: number
  /** Up this long and the failure streak is forgiven. */
  stableMs: number
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  cleanMs: 300,
  baseMs: 1_000,
  maxMs: 30_000,
  stableMs: 60_000,
}

/** Failures in a row after which only an explicit request skips the backoff. */
export const CRASH_LOOP_FAILURES = 3

/**
 * When to bring the browser back after it exited. A clean exit of a browser
 * that had been up (the window's X, ctrl+shift+q) comes back at once; a crash,
 * a kill or a start that dies right away backs off exponentially so a broken
 * profile can't spin the CPU.
 */
export function nextRestart(
  exit: { code: number | null; signal: string | null; uptimeMs: number },
  failures: number,
  policy: RestartPolicy = DEFAULT_RESTART_POLICY,
): { delayMs: number; failures: number } {
  if (exit.code === 0 && !exit.signal && exit.uptimeMs >= 5_000) {
    return { delayMs: policy.cleanMs, failures: 0 }
  }
  const streak = (exit.uptimeMs >= policy.stableMs ? 0 : failures) + 1
  return { delayMs: Math.min(policy.baseMs * 2 ** (streak - 1), policy.maxMs), failures: streak }
}

export type BrowserStatus =
  | { state: "running" | "starting" | "stopped" }
  | { state: "restarting"; inMs: number; failures: number; crashLoop: boolean }

export interface DesktopBrowserOptions {
  spawnBrowser?: (args: string[]) => BrowserProcess
  cdpUp?: () => Promise<boolean>
  repair?: () => Promise<void>
  policy?: RestartPolicy
  startTimeoutMs?: number
  log?: (msg: string) => void
}

function spawnChromium(args: string[]): BrowserProcess {
  const child = spawn(CHROMIUM, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, DISPLAY },
  })
  child.unref()
  return child
}

async function cdpAnswers(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
      signal: AbortSignal.timeout(1_000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * The browser on the desktop, driven over CDP (snapshots, element refs, tabs).
 * It is supervised: whenever Chromium exits (closed by a person or the agent,
 * crashed, OOM-killed) it is started again on the same profile, so the
 * computer never ends up as a bare black desktop. Only shutdown() stops it.
 */
export class DesktopBrowser {
  private pw: PwBrowser | null = null
  private connecting: Promise<PwBrowser> | null = null
  private launching: Promise<void> | null = null
  private stopping = false
  private failures = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartAt = 0
  private readonly spawnBrowser: (args: string[]) => BrowserProcess
  private readonly cdpUp: () => Promise<boolean>
  private readonly repair: () => Promise<void>
  private readonly policy: RestartPolicy
  private readonly startTimeoutMs: number
  private readonly log: (msg: string) => void

  constructor(opts: DesktopBrowserOptions = {}) {
    this.spawnBrowser = opts.spawnBrowser ?? spawnChromium
    this.cdpUp = opts.cdpUp ?? cdpAnswers
    this.repair = opts.repair ?? (() => repairProfile())
    this.policy = opts.policy ?? DEFAULT_RESTART_POLICY
    this.startTimeoutMs = opts.startTimeoutMs ?? 20_000
    this.log = opts.log ?? ((msg) => console.error(`[computer] ${msg}`))
  }

  /**
   * Start Chromium on the desktop if it isn't running. Called by the tools, so
   * an agent never sees a closed browser: a pending automatic restart happens
   * now, except in a crash loop (then it fails with the retry time).
   */
  launch(startUrl?: string): Promise<void> {
    if (this.restartTimer && !this.launching && this.failures >= CRASH_LOOP_FAILURES) {
      const secs = Math.max(1, Math.ceil((this.restartAt - Date.now()) / 1_000))
      return Promise.reject(
        new ComputerError(
          "browser_not_running",
          `the browser crashed ${this.failures} times in a row; it restarts by itself in ${secs}s (call wait, then retry)`,
        ),
      )
    }
    return this.start(startUrl)
  }

  /** A person asked for the browser (desktop menu): start it now, forgiving a crash loop. */
  relaunchNow(): Promise<void> {
    this.failures = 0
    return this.start()
  }

  status(): BrowserStatus {
    if (this.stopping) return { state: "stopped" }
    if (this.launching) return { state: "starting" }
    if (this.restartTimer) {
      return {
        state: "restarting",
        inMs: Math.max(0, this.restartAt - Date.now()),
        failures: this.failures,
        crashLoop: this.failures >= CRASH_LOOP_FAILURES,
      }
    }
    return { state: "running" }
  }

  private start(startUrl?: string): Promise<void> {
    if (this.stopping) {
      return Promise.reject(
        new ComputerError("browser_not_running", "the computer is shutting down"),
      )
    }
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.launching ??= this.doLaunch(startUrl).finally(() => {
      this.launching = null
    })
    return this.launching
  }

  private async doLaunch(startUrl?: string): Promise<void> {
    if (await this.cdpUp()) return
    await this.repair()
    const startedAt = Date.now()
    const child = this.spawnBrowser(chromiumArgs(startUrl))
    let exited = false
    child.on("exit", (code, signal) => {
      exited = true
      this.onExit(code, signal, Date.now() - startedAt)
    })
    const deadline = startedAt + this.startTimeoutMs
    while (Date.now() < deadline && !exited) {
      if (await this.cdpUp()) return
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new ComputerError(
      "browser_not_running",
      exited
        ? "Chromium exited right after starting; it is retried automatically"
        : `Chromium did not start within ${Math.round(this.startTimeoutMs / 1_000)}s`,
    )
  }

  private onExit(code: number | null, signal: string | null, uptimeMs: number): void {
    this.pw = null
    if (this.stopping) return
    const next = nextRestart({ code, signal, uptimeMs }, this.failures, this.policy)
    this.failures = next.failures
    this.log(
      `browser exited (${signal ?? `code ${code}`}, up ${Math.round(uptimeMs / 1_000)}s); restarting in ${next.delayMs}ms`,
    )
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartAt = Date.now() + next.delayMs
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start().catch((e) => this.log(`browser restart failed: ${e.message}`))
    }, next.delayMs)
  }

  /** True when the browser answers; waits for a launch already in flight (boot autostart). */
  async isRunning(): Promise<boolean> {
    if (this.launching) await this.launching.catch(() => undefined)
    return this.cdpUp()
  }

  /**
   * Close Chromium cleanly so it writes its cookie DB and session (it batches
   * cookie writes for ~30 s; a SIGKILL would lose the latest login).
   */
  async shutdown(timeoutMs = 4_000): Promise<void> {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    if (!(await this.cdpUp())) return
    try {
      const b = await this.connection(false)
      const session = await b.newBrowserCDPSession()
      await session.send("Browser.close").catch(() => undefined)
    } catch {
      /* intentional: best effort — the container is going away anyway */
    }
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && (await this.cdpUp())) {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  private async connection(autoLaunch: boolean): Promise<PwBrowser> {
    if (this.pw?.isConnected()) return this.pw
    if (!(await this.isRunning())) {
      if (!autoLaunch) {
        throw new ComputerError(
          "browser_not_running",
          "the browser is not running (it restarts by itself; open-url starts it now)",
        )
      }
      await this.launch()
    }
    this.connecting ??= chromium
      .connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, { timeout: 15_000 })
      .then((b) => {
        this.pw = b
        b.on("disconnected", () => {
          this.pw = null
        })
        return b
      })
      .finally(() => {
        this.connecting = null
      })
    return this.connecting
  }

  private async pages(autoLaunch = true): Promise<Page[]> {
    const b = await this.connection(autoLaunch)
    const ctx = b.contexts()[0]
    if (!ctx) throw new ComputerError("browser_not_running", "no browser window is open")
    return ctx.pages()
  }

  private targetIds = new WeakMap<Page, string>()

  private async targetId(page: Page): Promise<string | null> {
    const cached = this.targetIds.get(page)
    if (cached) return cached
    try {
      const session = await page.context().newCDPSession(page)
      const { targetInfo } = (await session.send("Target.getTargetInfo")) as {
        targetInfo: { targetId: string }
      }
      await session.detach().catch(() => undefined)
      this.targetIds.set(page, targetInfo.targetId)
      return targetInfo.targetId
    } catch {
      return null
    }
  }

  /**
   * The tab the user sees. DOM focus/visibility can't tell (Playwright emulates
   * focus on every attached page), but Chromium's /json/list is sorted by last
   * activation, so its first page target is the selected tab.
   */
  async activePage(autoLaunch = true): Promise<Page> {
    const pages = await this.pages(autoLaunch)
    if (pages.length === 0) return this.newTab()
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      })
      const targets = (await res.json()) as Array<{ id: string; type: string }>
      const top = targets.find((t) => t.type === "page")
      if (top) {
        for (const p of pages) if ((await this.targetId(p)) === top.id) return p
      }
    } catch {
      /* intentional: fall back to the most recent page */
    }
    return pages[pages.length - 1]
  }

  async tabs(): Promise<TabInfo[]> {
    const pages = await this.pages()
    const active = await this.activePage()
    return Promise.all(
      pages.map(async (p, index) => ({
        index,
        title: await p.title().catch(() => ""),
        url: p.url(),
        active: p === active,
      })),
    )
  }

  async switchTab(index: number): Promise<Page> {
    const pages = await this.pages()
    const page = pages[index]
    if (!page) throw new ComputerError("invalid_argument", `no tab ${index} (have ${pages.length})`)
    await page.bringToFront()
    return page
  }

  async closeTab(index: number): Promise<void> {
    const pages = await this.pages()
    const page = pages[index]
    if (!page) throw new ComputerError("invalid_argument", `no tab ${index} (have ${pages.length})`)
    await page.close()
  }

  /**
   * New tab in the existing window, like ctrl+t (Playwright's newPage would
   * open a separate window on a CDP-attached browser).
   */
  async newTab(url?: string): Promise<Page> {
    const b = await this.connection(true)
    const ctx = b.contexts()[0]
    const session = await b.newBrowserCDPSession()
    try {
      const pageEvent = ctx.waitForEvent("page", { timeout: 10_000 })
      await session.send("Target.createTarget", {
        url: "about:blank",
        newWindow: false,
        background: false,
      })
      const page = await pageEvent
      await page.bringToFront()
      if (url) await this.goto(page, url)
      return page
    } finally {
      await session.detach().catch(() => undefined)
    }
  }

  async goto(page: Page, url: string): Promise<void> {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
    } catch (error) {
      const msg = error instanceof Error ? error.message.split("\n")[0] : String(error)
      throw new ComputerError("navigation_failed", msg)
    }
    await page.bringToFront()
  }

  /**
   * Accessibility snapshot with element refs (`[ref=e12]`), the same format
   * the playwright MCA uses. Refs are valid until the page changes.
   */
  async snapshot(page: Page, maxChars: number): Promise<string> {
    const text = await page.ariaSnapshot({ mode: "ai", timeout: 10_000 }).catch(() => "")
    if (!text) return "(no accessibility tree: page still loading or not a web page)"
    if (text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}\n… (truncated at ${maxChars} chars; scroll or raise maxChars to see more)`
  }

  /** Element by snapshot ref, failing with element_not_found when stale. */
  async locate(page: Page, ref: string): Promise<Locator> {
    if (!/^[a-z]*\d*e\d+$/i.test(ref)) {
      throw new ComputerError("invalid_argument", `"${ref}" is not a snapshot ref (like e12)`)
    }
    const loc = page.locator(`aria-ref=${ref}`)
    if ((await loc.count().catch(() => 0)) === 0) {
      throw new ComputerError(
        "element_not_found",
        `ref ${ref} is not on the page anymore; call get-state for fresh refs`,
      )
    }
    return loc.first()
  }
}
