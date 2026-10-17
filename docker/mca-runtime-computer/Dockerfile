# MCA Runtime Container — Computer Edition (an agent's own Linux desktop)
#
# One container = one agent's computer: TigerVNC Xvnc (X server + VNC server in
# a single process, unix socket only), openbox, Debian Chromium and the
# mca.teros.computer server. The home directory (/home/teros: browser profile,
# downloads, dotfiles) is a per-app named volume (manifest runtime.appVolume),
# so logins and files survive container removal, idle stops and backend
# restarts. Everything else is disposable.
#
# Same Option A model as docker/mca-runtime: the MCA source is mounted at
# /app/mca at runtime and the SDK + deps are baked here. Unlike the other
# runtimes this one runs the MCA as an unprivileged user (uid 1000).
#
# Build (from repo root):
#   node scripts/gen-mca-union-deps.mjs
#   docker build -t teros/mca-runtime-computer:latest -f docker/mca-runtime-computer/Dockerfile .

ARG NOVNC_VERSION=1.6.0
ARG NOVNC_SHA256=5066103959ef4e9b10f37e5a148627360dd8414e4cf8a7db92bdbd022e728aaa

# ─────────────────────────────────────────────────────────────────
# Stage 1 — builder: @teros packages, this MCA's deps, noVNC client
# ─────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
ARG NOVNC_VERSION
ARG NOVNC_SHA256

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY packages/shared  /opt/teros-sdk/shared
COPY packages/mca-sdk /opt/teros-sdk/mca-sdk

RUN cd /opt/teros-sdk/shared && \
    npm install --no-audit --no-fund && \
    npm run build && \
    npm prune --omit=dev

RUN cd /opt/teros-sdk/mca-sdk && \
    node -e "const p=require('./package.json'); if(p.dependencies) delete p.dependencies['@teros/shared']; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2))" && \
    npm install --no-audit --no-fund && \
    mkdir -p node_modules/@teros && \
    ln -sfn /opt/teros-sdk/shared node_modules/@teros/shared && \
    npm run build && \
    npm prune --omit=dev && \
    mkdir -p node_modules/@teros && \
    ln -sfn /opt/teros-sdk/shared node_modules/@teros/shared

# Only mca.teros.computer's deps (scripts/gen-mca-union-deps.mjs, computer flavour)
COPY docker/mca-runtime-computer/deps.generated.json /opt/mca-deps/package.json
RUN cd /opt/mca-deps && npm install --omit=dev --no-audit --no-fund && \
    mkdir -p node_modules/@teros && \
    ln -sfn /opt/teros-sdk/shared  node_modules/@teros/shared && \
    ln -sfn /opt/teros-sdk/mca-sdk node_modules/@teros/mca-sdk

# noVNC browser client: ES modules straight from the release (the npm package
# ships CommonJS, which browsers can't import). Pinned by checksum.
RUN curl -fsSL -o /tmp/novnc.tgz "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" && \
    echo "${NOVNC_SHA256}  /tmp/novnc.tgz" | sha256sum -c - && \
    mkdir -p /opt/novnc && \
    tar -xzf /tmp/novnc.tgz -C /opt/novnc --strip-components=1 \
      "noVNC-${NOVNC_VERSION}/core" "noVNC-${NOVNC_VERSION}/vendor" "noVNC-${NOVNC_VERSION}/LICENSE.txt"

# ─────────────────────────────────────────────────────────────────
# Stage 2 — runtime
# ─────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim

# Desktop stack. No desktop environment: Xvnc + openbox is ~100 MiB RSS.
# Fonts cover Latin, emoji and CJK so any site renders like on a laptop.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tigervnc-standalone-server tigervnc-tools openbox xdotool xinput scrot \
      chromium \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
      tini curl ca-certificates git openssh-client procps \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g tsx typescript

# The desktop user: rename the base image's uid 1000 (node) to teros.
RUN usermod -l teros -d /home/teros -m node && groupmod -n teros node && \
    mkdir -p /app/mca /home/teros/Downloads /home/teros/.config && \
    chown -R teros:teros /home/teros

COPY --from=builder /opt/teros-sdk /opt/teros-sdk
COPY --from=builder /opt/mca-deps  /opt/mca-deps
COPY --from=builder /opt/novnc     /opt/novnc

COPY docker/mca-runtime/entrypoint.sh /entrypoint.sh
COPY docker/mca-runtime-computer/computer-entrypoint.sh /computer-entrypoint.sh
COPY docker/mca-runtime-computer/computer-session.sh /usr/local/bin/computer-session
COPY docker/mca-runtime-computer/openbox-rc.xml /etc/xdg/openbox/rc.xml
COPY docker/mca-runtime-computer/openbox-menu.xml /etc/xdg/openbox/menu.xml
COPY docker/mca-runtime-computer/teros-browser /usr/local/bin/teros-browser
# Managed browser policy: restore the last session on start (which also keeps
# session cookies, so a login survives a container restart like it survives a
# laptop reboot), no saved passwords on disk, no browser sign-in/sync.
COPY docker/mca-runtime-computer/chromium-policy.json /etc/chromium/policies/managed/teros.json
RUN chmod +x /entrypoint.sh /computer-entrypoint.sh /usr/local/bin/computer-session /usr/local/bin/teros-browser

ENV MCA_TRANSPORT=http
ENV MCA_HTTP_PORT=3000
ENV MCA_HTTP_HOST=0.0.0.0
ENV NODE_ENV=production
ENV MCA_RUN_DIR=/tmp/mca-run
ENV HOME=/home/teros
ENV DISPLAY=:1
ENV COMPUTER_GEOMETRY=1280x800
ENV COMPUTER_VNC_SOCKET=/tmp/teros-vnc/rfb.sock
ENV COMPUTER_NOVNC_DIR=/opt/novnc
ENV TZ=UTC
# Chromium's own sandbox needs user namespaces (blocked by Docker's default
# seccomp) or CAP_SYS_ADMIN for the SUID helper; neither is granted to MCA
# containers. The container is the sandbox: non-root user, egress-only network,
# no host mounts but its own volume. Set to 0 under a seccomp profile that
# allows unprivileged user namespaces (or gVisor) to get the renderer sandbox back.
ENV COMPUTER_CHROMIUM_NO_SANDBOX=1

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f -4 http://localhost:3000/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/computer-entrypoint.sh"]
