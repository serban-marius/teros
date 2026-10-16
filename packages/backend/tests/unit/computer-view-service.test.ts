/**
 * ComputerViewService — live view of an agent's computer.
 *
 * Tickets (signed, short-lived, bound to user + app), the /computer/<ticket>/
 * path parsing, and the HTTP proxy: it must forward to the container's
 * /viewer routes with the container's bearer token and the signed-in user,
 * refuse bad tickets, and respawn a container that vanished.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { PassThrough } from "node:stream"
import { ComputerViewService, VIEW_TICKET_TTL_MS } from "../../src/services/computer-view-service"

function fakeManager(baseUrl: () => string) {
  const calls: string[] = []
  return {
    calls,
    getOrSpawn: async (appId: string) => {
      calls.push(`spawn:${appId}`)
    },
    respawn: async (appId: string) => {
      calls.push(`respawn:${appId}`)
    },
    getContainerManager: () => ({
      getInfo: () => ({ status: "running", baseUrl: baseUrl() }) as never,
      getCallbackToken: () => "container-token",
      touch: (appId: string) => calls.push(`touch:${appId}`),
    }),
  }
}

describe("tickets", () => {
  const svc = new ComputerViewService(fakeManager(() => "http://x") as never, "secret")

  it("round-trip user + app", () => {
    const t = svc.issueTicket({ userId: "user_1", appId: "app_1", userName: "Ana" })
    expect(svc.verifyTicket(t)).toMatchObject({ userId: "user_1", appId: "app_1", userName: "Ana" })
  })

  it("reject tampering, foreign keys and garbage", () => {
    const t = svc.issueTicket({ userId: "user_1", appId: "app_1" })
    const [payload, sig] = t.split(".")
    const forged = Buffer.from(
      JSON.stringify({ userId: "user_2", appId: "app_1", exp: Date.now() + 1e6 }),
    ).toString("base64url")
    expect(svc.verifyTicket(`${forged}.${sig}`)).toBeNull()
    expect(svc.verifyTicket(`${payload}.${sig}x`)).toBeNull()
    expect(
      new ComputerViewService(fakeManager(() => "") as never, "other").verifyTicket(t),
    ).toBeNull()
    expect(svc.verifyTicket("nope")).toBeNull()
    expect(svc.verifyTicket("a.b.c")).toBeNull()
  })

  it("expire", () => {
    let now = 1_000
    const clocked = new ComputerViewService(fakeManager(() => "") as never, "secret", () => now)
    const t = clocked.issueTicket({ userId: "u", appId: "a" })
    now += VIEW_TICKET_TTL_MS - 1
    expect(clocked.verifyTicket(t)).not.toBeNull()
    now += 2
    expect(clocked.verifyTicket(t)).toBeNull()
  })

  it("stay valid across restarts with the same secret", () => {
    const t = svc.issueTicket({ userId: "u", appId: "a" })
    expect(
      new ComputerViewService(fakeManager(() => "") as never, "secret").verifyTicket(t),
    ).not.toBeNull()
  })
})

describe("parsePath", () => {
  it.each([
    ["/computer/aa.bb/", { ticket: "aa.bb", rest: "" }],
    ["/computer/aa.bb", { ticket: "aa.bb", rest: "" }],
    ["/computer/aa.bb/novnc/core/rfb.js", { ticket: "aa.bb", rest: "novnc/core/rfb.js" }],
    ["/computer/aa.bb/control?x=1", { ticket: "aa.bb", rest: "control?x=1" }],
  ])("%s", (url, expected) => {
    expect(ComputerViewService.parsePath(url)).toEqual(expected)
  })

  it("ignores other paths", () => {
    expect(ComputerViewService.parsePath("/computers/aa.bb/")).toBeNull()
    expect(ComputerViewService.parsePath("/computer/no-dot/")).toBeNull()
  })
})

describe("HTTP proxy", () => {
  let upstream: Server
  let proxy: Server
  let upstreamUrl = ""
  let proxyUrl = ""
  let upstreamUp = true
  const seen: Array<{
    url?: string
    auth?: string
    user?: string
    name?: string
    method?: string
  }> = []
  const manager = fakeManager(() => upstreamUrl)
  const svc = new ComputerViewService(manager as never, "secret")

  beforeAll(async () => {
    upstream = createServer((req: IncomingMessage, res) => {
      if (req.url === "/health") {
        res.writeHead(upstreamUp ? 200 : 503).end()
        return
      }
      seen.push({
        url: req.url,
        auth: req.headers.authorization,
        user: req.headers["x-teros-user-id"] as string,
        name: req.headers["x-teros-user-name"] as string,
        method: req.method,
      })
      res.writeHead(200, { "Content-Type": "text/plain", "Set-Cookie": "leak=1" })
      res.end("from computer")
    })
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r))
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
    proxy = createServer(async (req, res) => {
      if (!(await svc.handleHttp(req, res))) res.writeHead(404).end()
    })
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r))
    proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
  })

  afterAll(() => {
    upstream.close()
    proxy.close()
  })

  it("forwards to /viewer with the container token and the signed-in user", async () => {
    const t = svc.issueTicket({ userId: "user_1", appId: "app_1", userName: "María" })
    const res = await fetch(`${proxyUrl}/computer/${t}/novnc/core/rfb.js`)
    expect(await res.text()).toBe("from computer")
    expect(res.headers.get("set-cookie")).toBeNull()
    expect(seen.at(-1)).toEqual({
      url: "/viewer/novnc/core/rfb.js",
      auth: "Bearer container-token",
      user: "user_1",
      name: encodeURIComponent("María"),
      method: "GET",
    })
    expect(manager.calls).toContain("touch:app_1")
  })

  it("forwards POST bodies (take over / hand back)", async () => {
    const t = svc.issueTicket({ userId: "user_1", appId: "app_1" })
    await fetch(`${proxyUrl}/computer/${t}/control`, { method: "POST", body: '{"action":"take"}' })
    expect(seen.at(-1)).toMatchObject({ url: "/viewer/control", method: "POST" })
  })

  it("refuses bad tickets without touching the container", async () => {
    const before = seen.length
    const res = await fetch(`${proxyUrl}/computer/aaa.bbb/`)
    expect(res.status).toBe(401)
    expect(seen.length).toBe(before)
  })

  it("respawns a container that stopped answering", async () => {
    upstreamUp = false
    const fresh = new ComputerViewService(manager as never, "secret")
    const t = fresh.issueTicket({ userId: "user_1", appId: "app_9" })
    const proxy2 = createServer(async (req, res) => void (await fresh.handleHttp(req, res)))
    await new Promise<void>((r) => proxy2.listen(0, "127.0.0.1", r))
    await fetch(`http://127.0.0.1:${(proxy2.address() as { port: number }).port}/computer/${t}/`)
    proxy2.close()
    upstreamUp = true
    expect(manager.calls).toContain("respawn:app_9")
  })
})

describe("WebSocket upgrade", () => {
  const svc = new ComputerViewService(fakeManager(() => "http://127.0.0.1:9") as never, "secret")

  function upgrade(url: string): { handled: boolean; written: string } {
    const socket = new PassThrough()
    let written = ""
    socket.on("data", (d) => {
      written += d.toString()
    })
    const handled = svc.handleUpgrade(
      { url, headers: {} } as IncomingMessage,
      socket,
      Buffer.alloc(0),
    )
    return { handled, written }
  }

  it("rejects a bad ticket with 401 and other paths under the ticket with 404", () => {
    expect(upgrade("/computer/aaa.bbb/vnc")).toEqual({
      handled: true,
      written: "HTTP/1.1 401 Unauthorized\r\n\r\n",
    })
    const t = svc.issueTicket({ userId: "u", appId: "a" })
    expect(upgrade(`/computer/${t}/other`).written).toBe("HTTP/1.1 404 Not Found\r\n\r\n")
  })

  it("leaves non-computer paths to other handlers", () => {
    expect(upgrade("/ws").handled).toBe(false)
  })
})
