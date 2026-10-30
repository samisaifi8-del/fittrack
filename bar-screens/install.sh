#!/usr/bin/env bash
# Sets up Bar Screens on a Raspberry Pi running Raspberry Pi OS (with desktop).
# Run it from this folder as your normal user:  ./install.sh
# Safe to run again after updating. It leaves your other projects alone; switch between them with
# `bar-screens on` and `bar-screens off`.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_NAME="$(id -un)"

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as your normal user, without sudo. It asks for your password when it needs it."
  exit 1
fi

# Port 80 gives the shortest address, but another project (Pi-hole, a web app...) may already use it.
if [ -z "${PORT:-}" ]; then
  PORT=80
  if ! systemctl is-active --quiet bar-screens.service 2>/dev/null && ss -ltnH 'sport = :80' 2>/dev/null | grep -q .; then
    PORT=8080
    echo "==> Port 80 is taken by something else on this Pi, so Bar Screens will use port 8080."
  fi
fi

echo "==> Installing ffmpeg (converts phone videos into a format the Pi can play)"
sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg curl

if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then
  echo "==> Installing Chromium"
  sudo apt-get install -y -qq chromium || sudo apt-get install -y -qq chromium-browser
fi

echo "==> Setting up the Bar Screens server"
sudo tee /etc/systemd/system/bar-screens.service >/dev/null <<UNIT
[Unit]
Description=Bar Screens server
After=network.target

[Service]
User=$USER_NAME
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/python3 $APP_DIR/server.py --port $PORT
Restart=always
RestartSec=2
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload

echo "==> Installing the AirPlay receiver, so phones can mirror to the wall"
AIRPLAY_NAME="${AIRPLAY_NAME:-The Basement}"
if sudo apt-get install -y -qq uxplay gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-libav; then
  # UxPlay decodes the phone's picture and hands it to Bar Screens as JPEG frames on a local port,
  # so the display can fit it inside each wall's area.
  sudo tee /etc/systemd/system/bar-screens-airplay.service >/dev/null <<UNIT
[Unit]
Description=Bar Screens AirPlay receiver
After=network-online.target avahi-daemon.service
Wants=network-online.target

[Service]
User=$USER_NAME
ExecStart=$(command -v uxplay) -n "$AIRPLAY_NAME" -nh -s 1280x720 -vs "jpegenc quality=85 ! multipartmux boundary=frame ! tcpserversink host=127.0.0.1 port=7100"
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
else
  echo "    Couldn't install UxPlay, so phone mirroring is skipped. Everything else still works."
fi

echo "==> Adding the display to the desktop's startup apps"
chmod +x "$APP_DIR/kiosk.sh" "$APP_DIR/bar-screens"
mkdir -p "$HOME/.config/autostart" "$APP_DIR/data"
cat > "$HOME/.config/autostart/bar-screens-kiosk.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Bar Screens display
Exec=env BAR_SCREENS_URL=http://localhost:$PORT/display $APP_DIR/kiosk.sh
X-GNOME-Autostart-enabled=true
DESKTOP

echo "==> Adding the bar-screens on/off command"
sudo ln -sf "$APP_DIR/bar-screens" /usr/local/bin/bar-screens

if command -v raspi-config >/dev/null; then
  # The display needs the desktop running after boot, and the wall shouldn't go dark after 10 minutes.
  if [ "$(sudo raspi-config nonint get_autologin 2>/dev/null || echo 1)" != "0" ] || [ "$(sudo raspi-config nonint get_boot_cli 2>/dev/null || echo 1)" = "0" ]; then
    echo "==> Booting to the desktop and logging in automatically (needed for the display)"
    sudo raspi-config nonint do_boot_behaviour B4 || true
  fi
  echo "==> Turning off screen blanking"
  sudo raspi-config nonint do_blanking 1 || true
fi

"$APP_DIR/bar-screens" on >/dev/null
echo
echo "All set, and Bar Screens is switched on."
echo "  Restart the Pi once so the display starts:  sudo reboot"
echo "  Then open this on your phone (same Wi-Fi):  $("$APP_DIR/bar-screens" status | grep -o 'http[^ ]*')"
echo "  Mirror your iPhone: Control Centre > Screen Mirroring > $AIRPLAY_NAME"
echo "  Switch to your other project:  bar-screens off     Switch back:  bar-screens on"
