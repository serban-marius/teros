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

/** The browser on the desktop, driven over CDP (snapshots, element refs, tabs). */
export class DesktopBrowser {
  private pw: PwBrowser | null = null
  private connecting: Promise<PwBrowser> | null = null

  private async cdpUp(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, {
        signal: AbortSignal.timeout(1_000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  private launching: Promise<void> | null = null

  /** Start Chromium on the desktop if it isn't running (also after the user closed it). */
  launch(startUrl?: string): Promise<void> {
    this.launching ??= this.doLaunch(startUrl).finally(() => {
      this.launching = null
    })
    return this.launching
  }

  private async doLaunch(startUrl?: string): Promise<void> {
    if (await this.cdpUp()) return
    await repairProfile()
    const child = spawn(CHROMIUM, chromiumArgs(startUrl), {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, DISPLAY },
    })
    child.unref()
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (await this.cdpUp()) return
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new ComputerError("browser_not_running", "Chromium did not start within 20s")
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
        throw new ComputerError("browser_not_running", "the browser is closed; open-url starts it")
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
    const pages = await this.pages(false)
    const active = await this.activePage(false)
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
    const pages = await this.pages(false)
    const page = pages[index]
    if (!page) throw new ComputerError("invalid_argument", `no tab ${index} (have ${pages.length})`)
    await page.bringToFront()
    return page
  }

  async closeTab(index: number): Promise<void> {
    const pages = await this.pages(false)
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
