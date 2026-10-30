#!/usr/bin/env bash
# Shows the display page full-screen on the HDMI output. The desktop starts this at login, or on
# a Pi without a desktop the bar-screens-kiosk service runs it (see install.sh). It keeps running
# quietly in the background. Chromium is only open while Bar
# Screens is switched on, so the screen is free for other things the rest of the time.
APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
URL="${BAR_SCREENS_URL:-http://localhost/display}"
OFF_FLAG="$APP_DIR/data/display-off"
PROFILE="$HOME/.config/bar-screens-chromium"
BROWSER="$(command -v chromium || command -v chromium-browser)"

while true; do
  if [ ! -e "$OFF_FLAG" ] && curl -fs -o /dev/null "$URL"; then
    # After a power cut Chromium offers to "restore pages"; mark the last run as clean so it doesn't.
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' \
      "$PROFILE/Default/Preferences" 2>/dev/null
    "$BROWSER" --kiosk --noerrdialogs --disable-infobars --no-first-run \
      --disable-session-crashed-bubble --disable-features=Translate,TranslateUI \
      --autoplay-policy=no-user-gesture-required --check-for-update-interval=31536000 \
      --password-store=basic --ozone-platform-hint=auto --user-data-dir="$PROFILE" "$URL" &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      if [ -e "$OFF_FLAG" ]; then
        kill "$pid" 2>/dev/null
        wait "$pid" 2>/dev/null
        break
      fi
      sleep 2
    done
  fi
  sleep 2
done
