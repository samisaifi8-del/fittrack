# Bar Screens

Runs the LED walls at The Basement from a Raspberry Pi instead of ViPlex. The Pi plugs into the
NovaStar TB6's **HDMI IN**, shows a full-screen display page, and you control it from your phone
over the home Wi-Fi. It has TV-style channels (your own photos and videos, scores, news, weather,
deco visuals and party games), live mirroring from an iPhone, quick messages, brightness and
blackout.

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

The Basement's TB6 (Taurus T6) is set up as one **256 × 384** screen, so Bar Screens starts
with exactly that: 256 × 384 LED pixels, taken 1:1 from the top-left corner of the HDMI picture.
If the TB6 shows the HDMI picture pixel for pixel, that's already right.

To check, open **Screen setup** at the bottom of the control page with the test pattern on:

- **The green border sits on the wall's edges and the circle looks round?** You're done. Turn
  the test pattern off.
- **All four red corners are on the wall** (the whole pattern is squeezed on)? The TB6 is
  scaling the picture. Press **Whole HDMI picture**.
- **Something else?** The numbers on the coloured squares are HDMI pixel positions. Type in the
  area the wall shows (x, y, width, height).

Both walls almost certainly show the same picture (one TB6, one 256 × 384 screen). If they do,
leave **Right screen** switched off. If the test pattern shows different parts on each wall,
switch it on and give it its own area.

## 4. Use it

The control page works like a TV remote. Pick a channel for each wall:

| Channel | What it shows |
| --- | --- |
| 1 · The Bar | Your own photos, videos, text and clocks, taking turns. |
| 2 · Scores | Live football scores and this week's fixtures for the leagues you pick. |
| 3 · News | BBC headlines, one at a time, with a slow ticker of the rest. |
| 4 · Weather | Now, the next few hours and the next few days for your town. |
| 5 · Visuals | The Basement sign, a 1930s lift dial that settles on B, a deco clock, the city at dusk, champagne bubbles and deco fans. |
| 6 · Games | Party games on the wall, with phones as the controllers. |

Set leagues, news section, your town, the visual style, the game and the bar's name under
**Channel settings**. Scores, news and weather need the Pi to be online.

Your own content (channel 1):

- **+ Photo or video:** pick from your phone. Photos are resized to each wall's exact pixel size
  on the Pi, with clean, sharp edges. Phone videos are converted on the Pi first, which can take a
  minute.
- **+ Text / + Clock:** opens an editor with a live preview. Text sizes itself to fill the wall.
- **In rotation:** items take turns on channel 1. Set each one's time in its editor.
- **Show now:** pins one item over any channel until you press **Back to rotation** or
  **Back to channel**.
- **Quick message:** type it and it's on the wall straight away.
- **Brightness** and **Blackout** apply to everything.

## Games

Put a wall on channel 6 and pick a game. Guests open **http://<pi-name>.local/play** on their
phones (same Wi-Fi), type a name and join. No app needed.

- **Brick Breaker:** slide on the phone to move the paddle. Gold bricks take two hits; catch the
  W, M and S capsules for a wide paddle, extra balls or a slower ball.
- **Deco Duel:** two players, one ball, first to 7. Play alone and the house plays you.
- **Serpentine:** everyone gets a snake. Eat cherries to grow; gold coins are worth three.
- **Quick Draw:** wait for DRAW, then tap first. Too early is a false start. First to 5 wins.

## Live from your phone

On an iPhone, open **Control Centre**, tap **Screen Mirroring** and choose **The Basement**. Your
phone's screen shows on the wall (fitted inside it) until you stop mirroring, then the wall goes
back to its channel. Choose which wall and how it fits under **Live from your phone** on the
control page. This uses UxPlay, an open-source AirPlay receiver that the installer adds.

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

- It adds background services called `bar-screens` and `bar-screens-airplay` (the AirPlay
  receiver).
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
- **Phone mirroring doesn't show up or stays black.** Check the receiver is running with
  `systemctl status bar-screens-airplay`. This is the one part that couldn't be tested before it
  reached your Pi, so if it misbehaves, send the output of
  `journalctl -u bar-screens-airplay -n 50` to whoever is helping you.
- **Anyone on your Wi-Fi can open the control page.** Keep that in mind if guests use your
  network.
