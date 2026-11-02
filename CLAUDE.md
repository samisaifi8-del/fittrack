# The Basement (Bar Screens)

LED walls in Sami's basement: two portrait walls, each 256 × 384, fed by a NovaStar TB6 (Taurus T6) over HDMI from a
Raspberry Pi 4. The walls have **no sound**. Guests use their phones (games, drink orders, cameras); Sami uses the remote.

## Code

- This folder is a clone of `samisaifi8-del/fittrack`, branch `claude/led-screens-custom-firmware-mh5gsh`. Only
  `bar-screens/` is this project; the rest of the repo is FitTrack, leave it alone.
- `bar-screens/server.py` (Python standard library only, no pip) + `partygames.py` (the party-game kit).
- `static/display.html` = the wall kiosk (`/display`), `channels.js` = channel renderers, `party.js` / `fivelights.js`
  = party-game wall screens, `play.html` = guests' phones (`/play`), `control.html` = Sami's remote (`/control`,
  four tabs: Walls / Bar / Games / Settings), `film.html` = guests' intermission page, `live.html` = phone cameras.
- `static/content/*.json` = fact-checked question decks (numbers, clues, nights, verdict, drinks). Keep facts sourced.
- Channels: 1 The Bar, 2 Scores, 3 News, 4 Weather, 5 Visuals, 6 Games (Closest Wins, Five Clues, Five Lights,
  arcade), 7 Basement Live, 8 Now Showing, 9 Colours, 10 The House Pour, 11 The Verdict. Picking Colours or The
  Verdict moves a wall on a game channel to 9 / 11 (`_pick_game` / `_follow_game`).
- Sips (drinking rules) are opt-in per guest, off at 6 am, and the wall never shows who said no.

## Test

- `cd bar-screens && for t in test_*.py; do python3 -m unittest -q $t; done` (all must pass).
- Local server: `python3 server.py --port 8141 --host 127.0.0.1 --data <temp dir>`; drive it with headless Chrome.
- Look at wall screenshots at 256 × 384 (and enlarged): LED-legible type, no 1 px hairlines, per-frame work cached.
- Games must not call into the Store while holding the hub lock (use `hub.after(fn)`); `test_locks.py` guards this.

## Deploy (Pi)

- The Basement's own Pi 4 (since 2026-11-02): `samisaifi@basementscreens.local` (192.168.1.232 on Wi-Fi SAIFI),
  key `~/.ssh/basement_pi`, always `ssh -4`. Raspberry Pi OS with desktop (Debian 13, labwc), passwordless sudo.
  HDMI goes into the TB6 (it reports itself as `NOVASTARM3`, 1920 × 1080); the walls take the top-left 256 × 384.
- Set up with `install.sh` (desktop path: autostart kiosk, autologin, no blanking, blank cursor theme
  `BarScreensBlank` so no pointer sits on the walls). Control page `http://basementscreens.local/control`.
- Power: on full power since 2026-11-02 (`vcgencmd get_throttled` 0x0 with all cores flat out at 1.8 GHz). Its
  first supply, the TB6's USB port, was too weak for a Pi 4 (constant under-voltage, ~480 MHz): if 0x50005 shows
  up again, check the supply first. Kept from then: Bluetooth off (`dtoverlay=disable-bt`; original in
  `/boot/firmware/config.txt.orig`) and HDMI at 640 × 480 via `~/.config/kanshi/config` (the TB6 maps it 1:1, the
  walls look the same, and the Pi draws far less of a picture than at 1920 × 1080).
- It runs bare (no case, no fan). Safeguards: `Health` in server.py reads the temperature and `vcgencmd
  get_throttled` every 30 s for the remote (Settings › The Pi; a chip on every tab when ≥ 80 °C or short of power),
  and the hardware watchdog (`/etc/systemd/system.conf.d/bar-screens-watchdog.conf`, 15 s) reboots it if it freezes.
- STV's Pi (`stv@stv.local`, key `~/.ssh/stv_pi`) is STV's again; don't deploy Bar Screens there.
- Deploy = push the branch, then on the Pi:
  `cd ~/bar-screens-src && git pull && sudo systemctl restart bar-screens && pkill -f "[b]ar-screens-chromium"`
  (the kiosk relaunches itself). Server runs on port 80.
- Check the wall: `XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim /tmp/w.png`, then scp it back.
- Secure guest link: `bar-screens-tunnel.service` (cloudflared quick tunnel, metrics 127.0.0.1:3998). Through the
  tunnel only the guest pages work; `/control`, `/api/state` and `/display` return 403.
- Walls: s1 at HDMI x 0, s2 (right wall) at x 256, both 256 × 384. Different content per wall needs the TB6 set to
  512 × 384 with the right wall starting at X 256 in ViPlex Handy (Sami does that in the app).

## Rules learned the hard way

- **Never run `install.sh` on STV's Pi**: it switched it to desktop boot and broke STV. On the Basement Pi it's fine.
- Raspberry Pi Imager 2 writes cloud-init (`user-data`, `network-config` on bootfs). If SSH wasn't ticked, add
  `ssh_authorized_keys` + `enable_ssh` to `user-data` and give it a new `instance-id` (meta-data and cmdline.txt) so
  the Pi applies it again on the next boot.
- The TB6 must be in HDMI/sync mode (ViPlex Handy) or the walls show only its test screens.
- Don't claim something shows on the walls unless Sami confirms or a capture proves it.
- Pushing to the branch and deploying to the Pi are outward actions: do them when Sami asks ("send it over").
- Commit as you go, named paths only.
