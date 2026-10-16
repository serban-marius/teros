#!/bin/bash
# Root part of the computer's boot: prepare the volume, then drop to the
# desktop user for everything else (display, browser, MCA server).
set -e

HOME_DIR=/home/teros

# A fresh named volume is seeded from the image (already owned by teros). A
# volume created some other way (or an old one) gets fixed once.
if [ "$(stat -c %u "$HOME_DIR")" != "1000" ]; then
  chown -R 1000:1000 "$HOME_DIR"
fi
mkdir -p "$HOME_DIR/Downloads" "$HOME_DIR/.config"
chown 1000:1000 "$HOME_DIR/Downloads" "$HOME_DIR/.config"

exec runuser -u teros -- /usr/local/bin/computer-session
