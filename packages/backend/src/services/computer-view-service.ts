/**
 * Computer view service — live view + take-over of an agent's computer
 * (mca.teros.computer) from the Teros app.
 *
 * The computer serves its own viewer (noVNC page, control API, RFB over
 * WebSocket) on SDK extension routes that only accept the container's callback
 * token. Browsers never talk to the container: they load
 *
 *   GET  /computer/<ticket>/...   → container /viewer/...      (HTTP proxy)
 *   WS   /computer/<ticket>/vnc   → container /viewer/vnc      (upgrade proxy)
 *
 * where <ticket> is an HMAC-signed, short-lived {userId, appId} issued by the
 * `computer.open` WS action after checking workspace access. The ticket lives
 * in the path so every relative URL of the viewer page carries it.
 *
 * While a live view is connected the container is kept warm (touch), so the
 * idle reaper never stops a desktop a person is using.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http"
import type { Duplex } from "node:stream"
import type { McaContainerManager } from "./mca-container-manager"

export const COMPUTER_MCA_ID = "mca.teros.computer"

/** Time a ticket stays valid for loading the page / (re)connecting. */
export const VIEW_TICKET_TTL_MS = 10 * 60 * 1000
/** Keepalive cadence while a viewer is connected (well under MCA_IDLE_TIMEOUT_MS). */
const KEEPALIVE_MS = 60 * 1000

export interface ViewTicket {
  userId: string
  appId: string
  /** Display name shown in the computer's "who is in control" state. */
  userName?: string
  /** Expiry, epoch ms. */
  exp: number
}

/** Minimal surface of McaManager this service needs (eases testing). */
export interface ComputerMcaManager {
  getOrSpawn(appId: string): Promise<unknown>
  respawn(appId: string): Promise<unknown>
  getContainerManager(): Pick<McaContainerManager, "getInfo" | "getCallbackToken" | "touch">
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url")
}

/** A page load fetches dozens of files: probe the container at most this often. */
const REACHABLE_CACHE_MS = 5_000

export class ComputerViewService {
  private readonly key: Buffer
  private readonly lastReachable = new Map<string, number>()

  constructor(
    private readonly mcaManager: ComputerMcaManager,
    /** Stable secret so tickets survive restarts and work across instances. */
    secret: string | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.key = secret
      ? createHmac("sha256", secret).update("teros-computer-view-ticket-v1").digest()
      : randomBytes(32)
  }

  // ── Tickets ────────────────────────────────────────────────────────────────

  issueTicket(t: Omit<ViewTicket, "exp">, ttlMs = VIEW_TICKET_TTL_MS): string {
    const payload = b64url(JSON.stringify({ ...t, exp: this.now() + ttlMs }))
    const sig = b64url(createHmac("sha256", this.key).update(payload).digest())
    return `${payload}.${sig}`
  }

  verifyTicket(ticket: string): ViewTicket | null {
    const [payload, sig, extra] = ticket.split(".")
    if (!payload || !sig || extra !== undefined) return null
    const expected = createHmac("sha256", this.key).update(payload).digest()
    const given = Buffer.from(sig, "base64url")
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
    try {
      const t = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ViewTicket
      if (typeof t.userId !== "string" || typeof t.appId !== "string" || typeof t.exp !== "number")
        return null
      return t.exp > this.now() ? t : null
    } catch {
      return null
    }
  }

  /** `/computer/<ticket>/<rest>` → parts, or null if the path isn't ours. */
  static parsePath(url: string): { ticket: string; rest: string } | null {
    const m = url.match(/^\/computer\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(\/[^?#]*)?(\?[^#]*)?$/)
    if (!m) return null
    return { ticket: m[1], rest: (m[2] ?? "/").slice(1) + (m[3] ?? "") }
  }

  // ── Target resolution ──────────────────────────────────────────────────────

  /**
   * Start the computer if needed; base URL + bearer for its viewer routes.
   * Verifies the container answers: if it vanished behind the manager's back,
   * respawn it once instead of failing until the idle reaper notices.
   */
  async target(appId: string): Promise<{ baseUrl: string; token: string }> {
    await this.mcaManager.getOrSpawn(appId)
    let t = this.current(appId)
    const checkedAt = this.lastReachable.get(appId) ?? 0
    if (this.now() - checkedAt > REACHABLE_CACHE_MS) {
      if (!(await this.reachable(t.baseUrl))) {
        await this.mcaManager.respawn(appId)
        t = this.current(appId)
      }
      this.lastReachable.set(appId, this.now())
    }
    return t
  }

  private async reachable(baseUrl: string): Promise<boolean> {
    try {
      const res = await fetch(new URL("/health", baseUrl), { signal: AbortSignal.timeout(3_000) })
      return res.ok
    } catch {
      return false
    }
  }

  private current(appId: string): { baseUrl: string; token: string } {
    const cm = this.mcaManager.getContainerManager()
    const info = cm.getInfo(appId)
    const token = cm.getCallbackToken(appId)
    if (!info || info.status !== "running" || !token) throw new Error("computer is not running")
    cm.touch(appId)
    return { baseUrl: info.baseUrl, token }
  }

  private proxyHeaders(t: ViewTicket, token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      "X-Teros-User-Id": t.userId,
      ...(t.userName ? { "X-Teros-User-Name": encodeURIComponent(t.userName) } : {}),
    }
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────

  /** Handle `/computer/...` requests. Returns false for other paths. */
  async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const parsed = ComputerViewService.parsePath(req.url || "")
    if (!parsed) return false
    const t = this.verifyTicket(parsed.ticket)
    if (!t) {
      res.writeHead(401, { "Content-Type": "text/plain" })
      res.end("This computer view link has expired. Reopen the computer from Teros.")
      return true
    }
    if (req.method !== "GET" && req.method !== "POST") {
      res.writeHead(405).end()
      return true
    }
    let target: { baseUrl: string; token: string }
    try {
      target = await this.target(t.appId)
    } catch (error) {
      res.writeHead(503, { "Content-Type": "text/plain" })
      res.end(`The computer is not available: ${(error as Error).message}`)
      return true
    }
    const upstream = new URL(`/viewer/${parsed.rest}`, target.baseUrl)
    await new Promise<void>((resolve) => {
      const proxied = httpRequest(
        upstream,
        {
          method: req.method,
          headers: {
            ...this.proxyHeaders(t, target.token),
            ...(req.headers["content-type"] ? { "Content-Type": req.headers["content-type"] } : {}),
          },
          timeout: 30_000,
        },
        (up) => {
          const headers: Record<string, string | string[]> = {}
          for (const h of [
            "content-type",
            "cache-control",
            "content-length",
            "x-content-type-options",
          ]) {
            const v = up.headers[h]
            if (v !== undefined) headers[h] = v
          }
          // The Teros app embeds this page in an iframe; keep it out of
          // everyone else's frames and never let it be cached by proxies.
          headers["Referrer-Policy"] = "no-referrer"
          res.writeHead(up.statusCode ?? 502, headers)
          up.pipe(res)
          up.on("end", resolve)
          up.on("error", resolve)
        },
      )
      proxied.on("timeout", () => proxied.destroy(new Error("timeout")))
      proxied.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" })
        res.end("computer unreachable")
        resolve()
      })
      if (req.method === "POST") req.pipe(proxied)
      else proxied.end()
    })
    return true
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────

  /** Handle `/computer/<ticket>/vnc` upgrades. Returns false for other paths. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const parsed = ComputerViewService.parsePath(req.url || "")
    if (!parsed) return false
    const t = this.verifyTicket(parsed.ticket)
    if (!t || parsed.rest.split("?")[0] !== "vnc") {
      socket.end(`HTTP/1.1 ${t ? "404 Not Found" : "401 Unauthorized"}\r\n\r\n`)
      return true
    }
    void this.pipeUpgrade(t, req, socket, head)
    return true
  }

  private async pipeUpgrade(
    t: ViewTicket,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    let target: { baseUrl: string; token: string }
    try {
      target = await this.target(t.appId)
    } catch {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n")
      return
    }
    const passthrough = [
      "sec-websocket-key",
      "sec-websocket-version",
      "sec-websocket-protocol",
      "sec-websocket-extensions",
    ]
    const headers: Record<string, string> = {
      ...this.proxyHeaders(t, target.token),
      Connection: "Upgrade",
      Upgrade: "websocket",
    }
    for (const h of passthrough) {
      const v = req.headers[h]
      if (typeof v === "string") headers[h] = v
    }
    const upstreamReq = httpRequest(new URL("/viewer/vnc", target.baseUrl), { headers })
    upstreamReq.on("upgrade", (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 101 Switching Protocols`]
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v !== undefined) lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`)
      if (upHead.length) socket.write(upHead)
      if (head.length) upSocket.write(head)
      upSocket.pipe(socket)
      socket.pipe(upSocket)
      const keepalive = setInterval(() => {
        // Keep both the container (idle reaper) and the managed MCA warm.
        this.mcaManager.getContainerManager().touch(t.appId)
        void this.mcaManager.getOrSpawn(t.appId).catch(() => undefined)
      }, KEEPALIVE_MS)
      const close = () => {
        clearInterval(keepalive)
        upSocket.destroy()
        socket.destroy()
      }
      upSocket.on("close", close)
      upSocket.on("error", close)
      socket.on("close", close)
      socket.on("error", close)
    })
    upstreamReq.on("response", (r) => {
      socket.end(`HTTP/1.1 ${r.statusCode ?? 502} Upstream Refused\r\n\r\n`)
    })
    upstreamReq.on("error", () => socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"))
    upstreamReq.end()
  }
}
