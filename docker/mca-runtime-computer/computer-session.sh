#!/bin/bash
# Desktop session (runs as teros): Xvnc → openbox → MCA server (foreground).
# The MCA starts Chromium itself and restarts it whenever it exits, so a crashed or
# user-closed browser never takes the computer down.
set -e

export HOME=/home/teros
export DISPLAY="${DISPLAY:-:1}"
export USER=teros
SOCK="${COMPUTER_VNC_SOCKET:-/tmp/teros-vnc/rfb.sock}"
mkdir -p "$(dirname "$SOCK")" && chmod 700 "$(dirname "$SOCK")"
rm -f "$SOCK" /tmp/.X1-lock /tmp/.X11-unix/X1

# X + VNC in one process. RFB only on a 0600 unix socket (no TCP port, so no
# password is needed: only processes of this user in this container reach it).
# Viewers start view-only: pointer/clipboard via Accept* (runtime-settable),
# keyboard via the "TigerVNC keyboard" X device, disabled below (TigerVNC can't
# change AcceptKeyEvents at runtime). ControlLease flips both on take-over.
Xvnc "$DISPLAY" \
  -geometry "${COMPUTER_GEOMETRY:-1280x800}" -depth 24 \
  -rfbport -1 -rfbunixpath "$SOCK" -rfbunixmode 0600 \
  -SecurityTypes None -AlwaysShared \
  -AcceptPointerEvents=0 -AcceptKeyEvents=1 -AcceptCutText=0 -SendCutText=0 \
  -FrameRate 24 -nolisten tcp \
  > /tmp/xvnc.log 2>&1 &

for _ in $(seq 1 50); do
  [ -S "$SOCK" ] && xdotool getdisplaygeometry >/dev/null 2>&1 && break
  sleep 0.1
done

xinput disable "TigerVNC keyboard"

openbox > /tmp/openbox.log 2>&1 &

exec /entrypoint.sh
