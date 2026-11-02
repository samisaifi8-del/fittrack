#!/usr/bin/env bash
# Sets up Bar Screens on a Raspberry Pi running Raspberry Pi OS, with or without the desktop.
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

echo "==> Installing ffmpeg (converts phone videos into a format the Pi can play) and qrencode (QR codes)"
sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg curl qrencode

if ! command -v chromium >/dev/null && ! command -v chromium-browser >/dev/null; then
  echo "==> Installing Chromium"
  sudo apt-get install -y -qq chromium || sudo apt-get install -y -qq chromium-browser
fi

# With the desktop, the display opens as a startup app. Without it (Raspberry Pi OS Lite), a
# minimal full-screen kiosk (cage) runs Chromium straight on the HDMI output instead.
HAS_DESKTOP=0
for c in labwc wayfire lxsession startlxde-pi; do
  if command -v "$c" >/dev/null; then HAS_DESKTOP=1; fi
done

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

echo "==> Setting up the secure link for phone cameras (Basement Live)"
# Phones only allow the camera on https. A Cloudflare quick tunnel (free, no account) gives the Pi a
# trusted https://<random words>.trycloudflare.com address, new each time it starts. The server
# reads the current one from cloudflared's metrics port (127.0.0.1:3998) for the wall's QR code,
# and only serves the camera page through it.
if ! command -v cloudflared >/dev/null; then
  # Cloudflare's official package, from its GitHub releases, for this Pi's architecture
  CF_TMP="$(mktemp -d)"
  if curl -fsSL -o "$CF_TMP/cloudflared.deb" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$(dpkg --print-architecture).deb"; then
    sudo dpkg -i "$CF_TMP/cloudflared.deb" >/dev/null || true
  fi
  rm -rf "$CF_TMP"
fi
if command -v cloudflared >/dev/null; then
  sudo tee /etc/systemd/system/bar-screens-tunnel.service >/dev/null <<UNIT
[Unit]
Description=Bar Screens secure link for phone cameras (Cloudflare quick tunnel)
After=network-online.target bar-screens.service
Wants=network-online.target

[Service]
User=$USER_NAME
ExecStart=$(command -v cloudflared) tunnel --no-autoupdate --metrics 127.0.0.1:3998 --url http://localhost:$PORT
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
else
  echo "    Couldn't install cloudflared, so Basement Live has no secure link. Everything else still works."
fi

chmod +x "$APP_DIR/kiosk.sh" "$APP_DIR/bar-screens"
mkdir -p "$APP_DIR/data"
if [ "$HAS_DESKTOP" = 1 ]; then
  echo "==> Adding the display to the desktop's startup apps"
  mkdir -p "$HOME/.config/autostart"
  cat > "$HOME/.config/autostart/bar-screens-kiosk.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Bar Screens display
Exec=env BAR_SCREENS_URL=http://localhost:$PORT/display $APP_DIR/kiosk.sh
X-GNOME-Autostart-enabled=true
DESKTOP
  if command -v labwc >/dev/null; then
    # The desktop draws a pointer even with no mouse plugged in, and it lands on the walls. A cursor
    # theme whose every cursor is blank hides it for the desktop and Chromium alike (from next login).
    echo "==> Hiding the mouse pointer (a blank cursor theme for the desktop)"
    BLANK="$HOME/.local/share/icons/BarScreensBlank"
    mkdir -p "$BLANK/cursors"
    printf '[Icon Theme]\nName=BarScreensBlank\nComment=No pointer on the walls\n' > "$BLANK/index.theme"
    python3 - "$BLANK/cursors/blank" <<'PY'
import struct, sys
w = h = 8; size = 24
img = struct.pack('<9I', 36, 0xfffd0002, size, 1, w, h, 0, 0, 0) + b'\0' * (4 * w * h)
hdr = struct.pack('<4sIII', b'Xcur', 16, 0x10000, 1) + struct.pack('<3I', 0xfffd0002, size, 28)
open(sys.argv[1], 'wb').write(hdr + img)
PY
    for n in $(ls /usr/share/icons/*/cursors 2>/dev/null | grep -v ':$' | sort -u); do
      [ "$n" = blank ] || ln -sf blank "$BLANK/cursors/$n"
    done
    ENVF="$HOME/.config/labwc/environment"
    mkdir -p "$(dirname "$ENVF")"; touch "$ENVF"
    if grep -q '^XCURSOR_THEME=' "$ENVF"; then
      sed -i 's/^XCURSOR_THEME=.*/XCURSOR_THEME=BarScreensBlank/' "$ENVF"
    else
      echo 'XCURSOR_THEME=BarScreensBlank' >> "$ENVF"
    fi
  fi
else
  echo "==> No desktop on this Pi, so setting up a minimal full-screen display (cage)"
  sudo apt-get install -y -qq cage
  printf 'auth required pam_unix.so nullok\naccount required pam_unix.so\nsession required pam_unix.so\nsession required pam_systemd.so\n' \
    | sudo tee /etc/pam.d/bar-screens-kiosk >/dev/null
  sudo tee /etc/systemd/system/bar-screens-kiosk.service >/dev/null <<UNIT
[Unit]
Description=Bar Screens display (full-screen on the HDMI output)
After=systemd-user-sessions.service bar-screens.service dbus.socket systemd-logind.service getty@tty1.service
Wants=dbus.socket systemd-logind.service
Conflicts=getty@tty1.service

[Service]
User=$USER_NAME
PAMName=bar-screens-kiosk
TTYPath=/dev/tty1
TTYReset=yes
TTYVHangup=yes
TTYVTDisallocate=yes
StandardInput=tty-fail
UtmpIdentifier=tty1
UtmpMode=user
Environment=BAR_SCREENS_URL=http://localhost:$PORT/display
ExecStart=$(command -v cage) -s -- $APP_DIR/kiosk.sh
Restart=always
RestartSec=3

[Install]
WantedBy=graphical.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl set-default graphical.target
fi

echo "==> Adding the bar-screens on/off command"
sudo ln -sf "$APP_DIR/bar-screens" /usr/local/bin/bar-screens

if command -v raspi-config >/dev/null; then
  # The display needs the desktop running after boot, and the wall shouldn't go dark after 10 minutes.
  if [ "$HAS_DESKTOP" = 1 ] && { [ "$(sudo raspi-config nonint get_autologin 2>/dev/null || echo 1)" != "0" ] || [ "$(sudo raspi-config nonint get_boot_cli 2>/dev/null || echo 1)" = "0" ]; }; then
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
