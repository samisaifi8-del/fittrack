# Bar Screens

Runs the bar's LED walls from a Raspberry Pi instead of ViPlex. The Pi plugs into the NovaStar
TB6's **HDMI IN**, shows a full-screen display page, and you control it from your phone over the
home Wi-Fi: photos, videos, text, a clock, a rotation, quick messages, brightness and blackout.

```
Phone (home Wi-Fi) ──> Raspberry Pi ──HDMI──> NovaStar TB6 (HDMI IN) ──> LED wall
```

The TB6 keeps doing the part only it can do (turning the picture into the panels' signal), so
nothing on the wall itself is changed.

## What you need

- The Raspberry Pi 4, running **Raspberry Pi OS with desktop** and connected to your home Wi-Fi
- A **micro-HDMI to HDMI** cable. Use the Pi's HDMI port nearest the USB-C power socket.

## 1. Install (once)

Open a terminal on the Pi (or SSH in) and run:

```sh
git clone --depth 1 -b claude/led-screens-custom-firmware-mh5gsh https://github.com/samisaifi8-del/fittrack.git ~/bar-screens-src
cd ~/bar-screens-src/bar-screens
./install.sh
sudo reboot
```

**Without GitHub:** copy `bar-screens.zip` to the Pi (download it in the Pi's browser, or use a
USB stick), then run:

```sh
cd ~
unzip -o ~/Downloads/bar-screens.zip   # or wherever the zip is
cd ~/bar-screens
bash install.sh
sudo reboot
```

The installer prints the address of the control page when it finishes. It's usually
`http://<your-pi's-name>.local/control`, for example `http://raspberrypi.local/control`.

## 2. Connect it

1. Plug the Pi into the TB6's **HDMI IN**.
2. In ViPlex Handy, switch the TB6 to its HDMI (synchronous) mode.
3. Open the control page on your phone. The **test pattern** is on at first.

## 3. Line it up with the wall

Open **Screen setup** at the bottom of the control page and follow the four steps there. In
short:

- **All four red corners are on the wall** (the whole pattern is squeezed on)? Press
  **Whole HDMI picture**.
- **Only part of the pattern shows?** The numbers on the coloured squares are HDMI pixel
  positions. Type in the area the wall shows (x, y, width, height), then press **1:1**.
- Set **LED pixels** to the wall's resolution (ViPlex Handy shows it under Screen Management).
- When the green border sits on the wall's edges and the circle looks round, turn the test
  pattern off.

If the second wall runs off the same TB6, switch **Screen 2** to "In use" and set its area the
same way.

## 4. Use it

- **+ Photo or video:** pick from your phone. Each upload joins the rotation for the screen
  you're on. Phone videos are converted on the Pi first, which can take a minute.
- **+ Text / + Clock:** opens an editor with a live preview. Text sizes itself to fill the wall.
- **In rotation:** items take turns on the wall. Set each one's time in its editor.
- **Show now:** pins one item until you press **Back to rotation**.
- **Quick message:** type it, pick a colour, and it's on the wall straight away.
- **Brightness** and **Blackout** apply to everything.

## Sharing the Pi with another project

Bar Screens can be switched off so the Pi (and its HDMI output) is free for something else:

| Command | What it does |
| --- | --- |
| `bar-screens off` | Stops everything and frees the screen. Stays off after restarts. |
| `bar-screens on` | Starts it again. The display comes back within a few seconds. |
| `bar-screens status` | Shows whether it's running, and the control page address. |

There's also a **Use the Pi's screen output** switch on the phone page. It hands the HDMI output
to your other project while leaving the control page running, so you can switch back from your
phone.

If your other project doesn't use the screen (Pi-hole, Home Assistant, a bot), both can simply run
at the same time.

What the installer changes on the Pi:

- It adds a background service called `bar-screens`.
- It adds a startup entry that opens the display. The entry does nothing while Bar Screens is off.
- It sets the Pi to boot to the desktop and log in automatically, because the display needs the
  desktop.
- It turns off screen blanking.
- It uses port 80, or 8080 if something else already uses 80.

Uploads and settings live in `bar-screens/data/`.

## Updating

```sh
cd ~/bar-screens-src && git pull && cd bar-screens && ./install.sh
```

If you installed from the zip, unzip the new zip over the old folder with the same commands as
above (`unzip -o` replaces the files), then run `bash install.sh` again.

Your uploads and settings are kept either way.

## Troubleshooting

- **The wall is black after the Pi starts.** The Pi only looks for a screen when it powers on.
  Make sure the TB6 is on, then restart the Pi. If it keeps happening, add
  `video=HDMI-A-1:1920x1080@60D` to the end of the line in `/boot/firmware/cmdline.txt` and
  restart. This forces the HDMI output on.
- **The phone can't open the `.local` address.** Use the Pi's IP address instead: run
  `hostname -I` on the Pi, then open `http://<that address>/control`.
- **A video won't play.** Wait until "Converting video" disappears. If it says the conversion
  failed, try exporting the video from your phone as MP4.
- **Anyone on your Wi-Fi can open the control page.** Keep that in mind if guests use your
  network.
