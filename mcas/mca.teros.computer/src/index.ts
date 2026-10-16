#!/usr/bin/env npx tsx

/**
 * Teros Computer MCA
 *
 * An agent's own persistent Linux desktop: Xvnc + openbox + Chromium in this
 * container (started by docker/mca-runtime-computer/computer-entrypoint.sh),
 * the home directory on a per-app volume. This process exposes the
 * computer-use tools and the live view (viewer routes, see viewer.ts).
 */

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { McaServer } from "@teros/mca-sdk"
import { DesktopBrowser } from "./browser"
import { ControlLease } from "./control"
import { Desktop } from "./desktop"
import { run } from "./exec"
import { encodeShot, publishShot } from "./screenshot"
import { buildTools, type ComputerRuntime } from "./tools"
import { createViewerHttpHandler, createVncRelay } from "./viewer"

const HERE = dirname(fileURLToPath(import.meta.url))
const VNC_SOCKET = process.env.COMPUTER_VNC_SOCKET || "/tmp/teros-vnc/rfb.sock"
const NOVNC_DIR = process.env.COMPUTER_NOVNC_DIR || "/opt/novnc"
const HOME = process.env.HOME || "/home/teros"

export function createComputerRuntime(): ComputerRuntime {
  const desktop = new Desktop()
  const rt: ComputerRuntime = {
    desktop,
    browser: new DesktopBrowser(),
    control: new ControlLease((enabled) => desktop.setViewerInput(enabled)),
    scale: 1,
    async screenshot(width, quality) {
      const shot = await encodeShot(await desktop.capturePng(), width, quality)
      const url = await publishShot(shot)
      rt.scale = shot.scale
      return { url, width: shot.width, height: shot.height, scale: shot.scale }
    },
    runCommand: (command, timeoutMs) =>
      run("bash", ["-lc", command], { timeoutMs, cwd: HOME, maxBuffer: 16 * 1024 * 1024 }),
  }
  return rt
}

export function createComputerServer(rt = createComputerRuntime()): McaServer {
  const server = new McaServer({ id: "mca.teros.computer", name: "Computer", version: "1.0.0" })
  for (const tool of buildTools(rt)) server.tool(tool.name, tool.config)

  server.httpRoute(
    "/viewer",
    createViewerHttpHandler({
      staticDir: join(HERE, "..", "viewer"),
      novncDir: NOVNC_DIR,
      vncSocket: VNC_SOCKET,
      control: rt.control,
    }),
  )
  server.wsRoute("/viewer/vnc", createVncRelay(VNC_SOCKET))
  return server
}

const isDirectEntry = import.meta.url === `file://${process.argv[1]}`
if (isDirectEntry) {
  const rt = createComputerRuntime()
  createComputerServer(rt)
    .start()
    .then(async () => {
      console.error("Teros Computer MCA running")
      // The lease starts with the agent: make Xvnc agree (viewers view-only).
      await rt.control
        .handBack()
        .catch((e) => console.error("[computer] input gate failed:", e.message))
      // A computer should look like one when someone opens it: start the
      // browser right away (cheap; the profile restores the user's logins).
      if (process.env.COMPUTER_AUTOSTART_BROWSER !== "0") {
        await rt.browser
          .launch()
          .catch((e) => console.error("[computer] browser autostart failed:", e.message))
      }
    })
    .catch((err) => {
      console.error("Failed to start Teros Computer MCA:", err)
      process.exit(1)
    })

  // Idle stop / backend shutdown: `docker stop` sends SIGTERM first.
  process.once("SIGTERM", () => {
    rt.browser.shutdown().finally(() => process.exit(0))
  })
}
