# Computer (`mca.teros.computer`)

Every agent can have its own persistent Linux computer: a desktop with a real
Chromium that the agent drives with computer-use tools. A person can watch it
live from Teros, take over (for example to log into a site), and hand back.
Logins, tabs and files survive container restarts, idle stops and backend
restarts, like on a laptop.

- [Architecture](#architecture)
- [Tools](#tools)
- [Permissions](#permissions)
- [Live view and take-over](#live-view-and-take-over)
- [Persistence and robustness](#persistence-and-robustness)
- [Security](#security)
- [Cost and scale](#cost-and-scale)
- [Design decisions](#design-decisions)
- [Build and test](#build-and-test)

## Architecture

```
 Teros app                         Teros backend                         Execution host
 ┌────────────────────┐  computer.open  ┌──────────────────────────┐  start   ┌──────────────────────────────────────┐
 │ Agent window       │ ──────────────► │ ensure the agent's app   │ ───────► │ mca-teros-computer-<app> container   │
 │  [Computer]        │                 │ sign a view ticket (HMAC)│          │  Xvnc :1 (unix socket only, no TCP)  │
 │ Computer window    │ /computer/<t>/  │ ComputerViewService      │  Bearer  │  openbox                             │
 │  iframe: noVNC ────┼───────────────► │  HTTP + WS reverse proxy │ ───────► │  node MCA :3000                      │
 └────────────────────┘                 │ McaToolExecutor          │  token   │   /tools/call   computer-use tools   │
 Agent loop ── tool calls ────────────► │                          │ ───────► │   /viewer/*     noVNC + control API  │
 Screenshots ── /api/media/upload ────► │ media store → LLM        │          │  chromium (CDP on 127.0.0.1:9222)    │
                                        └──────────────────────────┘          │  volume teros-app-<appId> → ~        │
                                                                              └──────────────────────────────────────┘
```

- **One computer per agent.** Each computer is an app instance of this MCA
  (`multi: true`, `containerMode: per-app`). It is tagged `App.forAgentId`
  and granted to that agent only. It is created on first use (the
  **Computer** button calls `computer.open`), or for every agent when an
  operator turns on `availability.system` (`availability.perAgent` makes
  provisioning per agent).
- **Runtime image** `teros/mca-runtime-computer`
  (`docker/mca-runtime-computer/`). Debian bookworm-slim with TigerVNC `Xvnc`
  (X and VNC in one process), openbox, Debian `chromium` and this MCA. It
  runs as uid 1000 under `tini`.
- **Driving the browser.** `playwright-core` attaches over CDP. Pages are read
  with `page.ariaSnapshot({ mode: "ai" })`, whose element refs look like
  `[ref=e12]`. Coordinates, keys and drags go through `xdotool` (XTEST), so
  they also work on dialogs and non-browser windows. Chromium runs as a
  normal user browser, with no automation flags.
- **Teaching the agent.** [`AGENT.md`](AGENT.md) (~500 tokens) is injected
  into `<app_instructions>` for every agent that has a computer (manifest
  field `agentInstructions`).

## Tools

Tools are exposed as `<app>_<tool>`, for example `computer-ada_click`.

| Tool | What it does |
|---|---|
| `get-state` | Who is in control, the focused window, the tab, and an accessibility snapshot with refs; optional screenshot. Also restarts a closed browser and brings a minimized one back. |
| `screenshot` | Downscaled JPEG (1024 px wide). Later `x,y` arguments are pixels of this image and are scaled to the screen automatically. |
| `click`, `type-text`, `press-key`, `scroll`, `drag` | Input, by `ref` or by coordinates. |
| `open-url`, `tabs`, `wait` | Navigation and waiting. |
| `run-command` | Shell command as the desktop user, in `~`. |
| `control-status` | Who drives right now. |

- **Fresh state after every action.** `observe` selects what comes back:
  `snapshot` (default), `summary`, `screenshot` or `none`.
- **Verification label on every action:** `verified` (the effect was read
  back), `delivered`, or `unverified (synthetic input)`.
- **Error codes** (the first token of the error): `human_has_control`,
  `element_not_found`, `browser_not_running`, `invalid_argument`,
  `navigation_failed`, …

## Permissions

A desktop loop is dozens of small steps, so asking for each one made the
feature unusable. On an agent's **own** computer, the defaults are:

| Tools | Default | Why |
|---|---|---|
| `get-state`, `screenshot`, `wait`, `control-status` | allow | read-only (`readOnlyHint`) |
| `click`, `type-text`, `press-key`, `scroll`, `drag`, `open-url`, `tabs` | allow | `sandboxedHint`: they act only inside the agent's own sandbox, and a person can watch every effect in the live view |
| `run-command` | ask | its effect is invisible, and it can read the browser profile (cookies) and send data out |

`sandboxedHint` is a new, generic tool annotation (shared schema + SDK). It
has an effect only when permissions are seeded for an app provisioned for one
agent (`App.forAgentId`). On a shared instance the same tools seed as `ask`,
and `alwaysAsk` always wins. After seeding, permissions are ordinary user
data: each tool can be switched between Auto, Confirm and Block in the app's
**Permissions** panel. Migration `20261017_001` brings per-agent apps created
earlier to these defaults. It changes only tools that are still `ask`, and it
skips apps with an app-wide allow or forbid default.

The real safety boundaries are elsewhere:

- **Human take-over for logins.** The agent never types passwords, 2FA codes
  or payment data.
- **The agent guide's rules:** no purchases, sends, deletes or account
  changes unless the user asked.
- **The container sandbox.**

## Live view and take-over

- **Two entry points.** The **Computer** button on the agent window, and
  **Open computer** on every computer tool card in chat.
- **Tickets.** `computer.open` checks workspace access (a superagent's
  computer opens only for its owner) and returns a ticket URL valid for
  10 minutes. The tickets are HMAC-signed with a key derived from the
  session secret.
- **Proxy.** The backend proxies `/computer/<ticket>/` (HTTP + WebSocket) to
  the container's viewer routes. Those are SDK extension routes
  (`httpRoute`/`wsRoute`) that require the container's callback token, so
  only the backend can reach them.
- **The lease is enforced inside the X server.**
  - Pointer and clipboard: Xvnc parameters, set at runtime and read back.
  - Keyboard: TigerVNC can't change `AcceptKeyEvents` at runtime, so Xvnc's
    "TigerVNC keyboard" X device is disabled and enabled with `xinput`.
  - While a person drives, the agent's input tools fail with
    `human_has_control`.

## Persistence and robustness

- **Persistent home.** `~` is a named volume per computer
  (`teros-app-<appId>`, manifest `runtime.appVolume`). It holds the Chromium
  profile, `~/Downloads` and dotfiles.
- **Sessions survive restarts.** The managed policy `RestoreOnStartup=1`
  keeps session cookies and tabs across restarts.
- **Clean shutdown.** `docker stop` sends SIGTERM. The MCA then closes
  Chromium over CDP so cookies are flushed. The container backend now stops
  containers before removing them.
- **Profile repair.** A SIGKILLed profile is repaired on start: the
  singleton lock is removed and the exit is marked clean.
- **The browser always comes back.** The MCA supervises Chromium. If it is
  closed (its own X button), crashes or is OOM-killed, it restarts on the
  same profile.
  - A clean close restarts in 0.3 s.
  - Crashes back off from 1 s to 30 s.
  - It never restarts during shutdown.
- **Desktop menu.** Right-clicking the desktop opens a menu (Browser,
  Windows) that brings back a closed or minimized browser.

## Security

- **No VNC exposure.** VNC is never on a TCP port: a 0600 unix socket inside
  the container. Browsers only reach the backend, with a ticket bound to one
  user and one computer. The proxy forwards only safe response headers.
- **Network.** Egress network only, never the database network.
- **Sandbox.**
  - Chromium runs with `--no-sandbox`: Docker's default seccomp blocks user
    namespaces, and the SUID helper needs `CAP_SYS_ADMIN`.
  - The container is the boundary: non-root, egress-only, no host mounts
    besides its own volume.
  - Set `COMPUTER_CHROMIUM_NO_SANDBOX=0` under a seccomp profile that allows
    user namespaces, or under gVisor.
- **No stored passwords.** The browser password manager is disabled by
  policy, so no saved passwords sit on the volume.
- **`run-command` stays on ask** (see [Permissions](#permissions)). For
  stricter deployments, set it to Block per app.

## Cost and scale

Measured on OrbStack, arm64:

| | |
|---|---|
| Stopped (idle-reaped) | 0 RAM, 0 CPU; disk = profile volume (~100 MiB, HTTP cache capped at 64 MiB) |
| Running, idle, one page open | ~420 MiB, ~0.05 % CPU |
| Cold start | 1.2–2.6 s |
| Live view connected | +0.3 % CPU; nothing streams without a viewer |
| Screenshot | ~55 KB JPEG |
| Real agent task (8 steps) | ~30 s |

RAM is the limit: ~0.5 GiB per running desktop. Idle desktops are stopped by
the idle reaper and cost only disk.

## Design decisions

- **Container, not a VM.** A microVM costs a fixed guest kernel and RAM
  reservation per desktop and needs nested virtualisation. gVisor is the
  drop-in hardening path.
- **One app instance per agent,** rather than a new container mode. It reuses
  per-app containers, grants, permissions and the idle reaper unchanged.
- **Xvnc + openbox + an MCA-side WebSocket relay.** Fewest processes, no
  Python, no TCP VNC port.
- **Debian Chromium as a normal browser.** Sites must not see automation.
- **Snapshot refs for page targets, screenshot-pixel coordinates for
  everything else.** Text is ~10× cheaper than pixels for the model.
- **Screenshots uploaded to the backend media store.** The resulting URL
  works on single-host and split deployments alike.
- **Keep the browser's close button.** Removing it means kiosk mode, which
  also hides the tabs and address bar a person needs. Supervision makes
  closing harmless.
- **Desktop GUI tools allowed by default on the agent's own computer;
  `run-command` asks.** The rule: an effect visible in the live view is
  allowed, an invisible one asks.

## Build and test

```sh
# Image (from the repo root)
node scripts/gen-mca-union-deps.mjs
docker build -t teros/mca-runtime-computer -f docker/mca-runtime-computer/Dockerfile .

# Unit tests (fake desktop) + smoke tests against the real image (skipped without Docker/image)
cd mcas/mca.teros.computer
bun test test/unit
bun test test/integration
```
