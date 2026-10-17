/**
 * Smoke test against the real runtime image (teros/mca-runtime-computer):
 * desktop boot, the agent tools over the MCA HTTP protocol, screenshot upload,
 * the take-over fence, and persistence of browser state + home files across
 * `docker rm -f`. Hermetic: the test page is served from inside the container
 * and media uploads go to a fake backend in this process.
 *
 * Skipped when Docker or the image is missing. Build it first:
 *   node scripts/gen-mca-union-deps.mjs
 *   docker build -t teros/mca-runtime-computer -f docker/mca-runtime-computer/Dockerfile .
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { createServer, type Server } from "node:http"
import { resolve } from "node:path"

const IMAGE = "teros/mca-runtime-computer"
const MCA_DIR = resolve(import.meta.dir, "../..")
const TOKEN = "smoke-token"
const NAME = `computer-smoke-${process.pid}`
const VOLUME = `teros-app-smoke-${process.pid}`
const PORT = 15900 + (process.pid % 90)

const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8" })
const available = docker("image", "inspect", IMAGE).status === 0

let mediaServer: Server
let mediaPort = 0
let uploads = 0

async function startComputer(): Promise<void> {
  docker("rm", "-f", NAME)
  const r = docker(
    "run",
    "-d",
    "--name",
    NAME,
    "-p",
    `127.0.0.1:${PORT}:3000`,
    "--add-host=host.docker.internal:host-gateway",
    "-v",
    `${MCA_DIR}:/app/mca:ro`,
    "-v",
    `${VOLUME}:/home/teros`,
    "-e",
    `MCA_CALLBACK_TOKEN=${TOKEN}`,
    "-e",
    `MCA_CALLBACK_BASE_URL=http://host.docker.internal:${mediaPort}`,
    IMAGE,
  )
  if (r.status !== 0) throw new Error(r.stderr)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return
    } catch {
      /* booting */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error("computer did not become healthy")
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "1",
      type: "tool_call",
      timestamp: "",
      version: "1",
      tool: name,
      arguments: args,
      context: { userId: "u" },
    }),
  })
  const body = (await res.json()) as {
    success: boolean
    result?: { output: string }
    error?: { message: string }
    attachments?: unknown[]
  }
  if (!body.success) throw new Error(body.error?.message)
  return { output: body.result?.output ?? "", attachments: body.attachments }
}

async function control(action: "take" | "release") {
  const res = await fetch(`http://127.0.0.1:${PORT}/viewer/control`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "X-Teros-User-Id": "user_smoke",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action }),
  })
  return res.json() as Promise<{ holder: string }>
}

/** A tiny site inside the container: a form, and a page echoing its persistent cookie. */
const SITE = `node -e '
require("http").createServer((q, s) => {
  s.setHeader("Content-Type", "text/html");
  if (q.url.startsWith("/login")) { s.setHeader("Set-Cookie", "smoke=yes; Max-Age=86400; Path=/"); return s.end("<h1>Logged in</h1>"); }
  if (q.url.startsWith("/whoami")) return s.end("<p id=c>cookie:" + (q.headers.cookie || "none") + "</p>");
  s.end("<label>Name <input id=n></label><button onclick=\\"document.title=document.getElementById(\\x27n\\x27).value\\">Save</button>");
}).listen(8099, "127.0.0.1");' > /tmp/site.log 2>&1 &
for i in $(seq 1 100); do (echo > /dev/tcp/127.0.0.1/8099) 2>/dev/null && break; sleep 0.1; done`

const describeIf = available ? describe : describe.skip

describeIf("computer runtime image (smoke)", () => {
  beforeAll(async () => {
    mediaServer = createServer((req, res) => {
      const ok = req.headers.authorization === `Bearer ${TOKEN}`
      uploads += ok ? 1 : 0
      res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" })
      res.end(
        JSON.stringify(
          ok ? { success: true, url: `http://media.test/media/${uploads}` } : { success: false },
        ),
      )
    })
    await new Promise<void>((r) => mediaServer.listen(0, "0.0.0.0", r))
    mediaPort = (mediaServer.address() as { port: number }).port
    await startComputer()
  }, 90_000)

  afterAll(() => {
    docker("rm", "-f", NAME)
    docker("volume", "rm", VOLUME)
    mediaServer?.close()
  })

  it("boots a desktop with a browser", async () => {
    const r = await tool("get-state")
    expect(r.output).toContain("Screen: 1280×800")
    expect(r.output).toContain("Control: agent")
  }, 30_000)

  it("drives a page by refs and reads the result back", async () => {
    await tool("run-command", { command: SITE })
    const opened = await tool("open-url", { url: "http://127.0.0.1:8099/" })
    const ref = opened.output.match(/textbox "Name" \[ref=(e\d+)\]/)?.[1]
    const button = opened.output.match(/button "Save" \[ref=(e\d+)\]/)?.[1]
    expect(ref && button).toBeTruthy()
    const typed = await tool("type-text", { ref, text: "Ada", observe: "none" })
    expect(typed.output).toContain("verified")
    const clicked = await tool("click", { ref: button, observe: "summary" })
    expect(clicked.output).toContain('— "Ada"')
  }, 60_000)

  it("uploads downscaled screenshots with its callback token", async () => {
    const r = await tool("screenshot", { width: 640 })
    expect(r.attachments).toEqual([
      { url: `http://media.test/media/${uploads}`, mime: "image/jpeg", filename: "screen.jpg" },
    ])
    expect(r.output).toContain("640×400 (scale 2.000)")
  }, 30_000)

  it("fences the agent while a person holds control", async () => {
    expect((await control("take")).holder).toBe("human")
    await expect(tool("press-key", { keys: "Tab" })).rejects.toThrow(/^human_has_control/)
    expect((await tool("get-state", { maxChars: 500 })).output).toContain("Control: HUMAN")
    expect((await control("release")).holder).toBe("agent")
    await expect(tool("press-key", { keys: "Tab", observe: "none" })).resolves.toBeTruthy()
  }, 30_000)

  it("keeps logins and home files across docker rm -f", async () => {
    await tool("open-url", { url: "http://127.0.0.1:8099/login", observe: "none" })
    await tool("run-command", { command: "echo kept > ~/Downloads/smoke.txt" })
    // Chromium batches cookie writes; the graceful path (docker stop) flushes,
    // SIGKILL only keeps what was written. Give it the flush window.
    docker("stop", "--time", "10", NAME)
    await startComputer()
    expect((await tool("run-command", { command: "cat ~/Downloads/smoke.txt" })).output).toContain(
      "kept",
    )
    await tool("run-command", { command: SITE })
    const page = await tool("open-url", { url: "http://127.0.0.1:8099/whoami" })
    expect(page.output).toContain("cookie:smoke=yes")
  }, 120_000)

  it("brings the browser back when it is closed or killed, still logged in", async () => {
    const health = async () => (await tool("-health-check")).output
    const until = async (ok: (s: string) => boolean, ms: number) => {
      const deadline = Date.now() + ms
      let s = await health()
      while (!ok(s) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100))
        s = await health()
      }
      return s
    }
    const up = (s: string) => s.includes("browser running")

    // A person clicking the window's X: Chromium's own close button, top right.
    docker("exec", "-u", "teros", NAME, "xdotool", "mousemove", "1260", "20", "click", "1")
    expect(up(await until((s) => !up(s), 5_000))).toBe(false)
    expect(await until(up, 15_000)).toContain("browser running")
    expect((await tool("get-state", { maxChars: 500 })).output).toContain("Browser: http")

    // A crash or OOM kill of the browser process: back without any tool call.
    expect(docker("exec", NAME, "pkill", "-KILL", "-o", "-x", "chromium").status).toBe(0)
    expect(up(await until((s) => !up(s), 5_000))).toBe(false)
    expect(await until(up, 20_000)).toContain("browser running")
    const page = await tool("open-url", { url: "http://127.0.0.1:8099/whoami" })
    expect(page.output).toContain("cookie:smoke=yes")
  }, 90_000)

  it("rejects viewer routes without the backend token", async () => {
    expect((await fetch(`http://127.0.0.1:${PORT}/viewer/control`)).status).toBe(401)
  })
})
