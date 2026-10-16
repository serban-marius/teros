import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ControlLease } from "../../src/control"
import { createViewerHttpHandler, safeJoin } from "../../src/viewer"

describe("safeJoin", () => {
  it("resolves inside the root and refuses escapes", () => {
    expect(safeJoin("/opt/novnc", "core/rfb.js")).toBe("/opt/novnc/core/rfb.js")
    expect(safeJoin("/opt/novnc", "../../etc/passwd")).toBeNull()
    expect(safeJoin("/opt/novnc", "%2e%2e/%2e%2e/etc/passwd")).toBeNull()
    expect(safeJoin("/opt/novnc", "a\0b")).toBeNull()
    expect(safeJoin("/opt/novnc", "%E0%A4%A")).toBeNull()
  })
})

describe("viewer HTTP handler", () => {
  let server: Server
  let base: string
  let dir: string
  const applied: boolean[] = []
  const control = new ControlLease(async (enabled) => {
    applied.push(enabled)
  })

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "viewer-"))
    mkdirSync(join(dir, "static"))
    mkdirSync(join(dir, "novnc", "core"), { recursive: true })
    writeFileSync(join(dir, "static", "index.html"), "<html>viewer</html>")
    writeFileSync(join(dir, "novnc", "core", "rfb.js"), "export default 1")
    const handler = createViewerHttpHandler({
      staticDir: join(dir, "static"),
      novncDir: join(dir, "novnc"),
      vncSocket: "/nonexistent",
      control,
    })
    server = createServer((req, res) => void handler(req, res))
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
    const addr = server.address() as { port: number }
    base = `http://127.0.0.1:${addr.port}`
  })

  afterAll(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("serves the page and the noVNC modules", async () => {
    const page = await fetch(`${base}/viewer/`)
    expect(page.headers.get("content-type")).toContain("text/html")
    expect(await page.text()).toBe("<html>viewer</html>")
    const mod = await fetch(`${base}/viewer/novnc/core/rfb.js`)
    expect(mod.headers.get("content-type")).toContain("javascript")
  })

  it("404s outside its roots", async () => {
    expect((await fetch(`${base}/viewer/novnc/..%2F..%2Fstatic%2Findex.html`)).status).toBe(404)
    expect((await fetch(`${base}/viewer/missing.js`)).status).toBe(404)
  })

  it("take-over needs the user forwarded by the backend; release needs nothing", async () => {
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}/viewer/control`, { method: "POST", body: JSON.stringify(body), headers })
    expect((await post({ action: "take" })).status).toBe(400)
    const took = await post(
      { action: "take" },
      { "X-Teros-User-Id": "user_1", "X-Teros-User-Name": "Mar%C3%ADa" },
    )
    expect(await took.json()).toMatchObject({
      holder: "human",
      userId: "user_1",
      displayName: "María",
    })
    expect(await (await fetch(`${base}/viewer/control`)).json()).toMatchObject({ holder: "human" })
    expect(await (await post({ action: "release" })).json()).toMatchObject({ holder: "agent" })
    expect(applied).toEqual([true, false])
    expect((await post({ action: "steal" })).status).toBe(400)
  })

  it("only GET for files", async () => {
    expect((await fetch(`${base}/viewer/`, { method: "POST" })).status).toBe(405)
  })
})
