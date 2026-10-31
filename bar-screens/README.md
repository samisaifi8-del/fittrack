# Bar Screens

Runs the LED walls at The Basement from a Raspberry Pi instead of ViPlex. The Pi plugs into the
NovaStar TB6's **HDMI IN**, shows a full-screen display page, and you control it from your phone
over the home Wi-Fi. It has TV-style channels (your own photos and videos, scores, news, weather,
deco visuals, party games, guests' phone cameras and the house drinks card), live mirroring from
an iPhone, quick messages, brightness and blackout.

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

To check, open **Settings › Screens › Left wall** on the control page with the test pattern on:

- **The green border sits on the wall's edges and the circle looks round?** You're done. Turn
  the test pattern off.
- **All four red corners are on the wall** (the whole pattern is squeezed on)? The TB6 is
  scaling the picture. Press **Whole HDMI picture**.
- **Something else?** The numbers on the coloured squares are HDMI pixel positions. Type in the
  area the wall shows (x, y, width, height).

Both walls almost certainly show the same picture (one TB6, one 256 × 384 screen). If they do,
leave **Right wall** switched off. If the test pattern shows different parts on each wall,
switch it on and give it its own area (**Right wall area**).

## 4. Use it

The control page works like a TV remote, with four tabs along the bottom: **Walls** (the
channels), **Bar** (The House Pour), **Games** and **Settings**. **Message** and **Blackout** are
one tap away on every tab, and guests' drink requests and Verdict prompts slide up above them
(**Make it** / **Not now**, **Approve** / **Reject**; the tray at the top right lists them all).
Opening a tab never changes the walls: only a channel, or a "Put … up" button, does.

On **Walls**, the two small drawings show what each wall has on, and the row under them holds the
on-air channel's own settings. The **Both walls** pill picks which walls a channel acts on (left,
right or both). The nine channels:

| Channel | What it shows |
| --- | --- |
| 1 · The Bar | Your own photos, videos, text and clocks, taking turns. |
| 2 · Scores | Live football scores and this week's fixtures for the leagues you pick. |
| 3 · News | BBC headlines, one at a time, with a slow ticker of the rest. |
| 4 · Weather | Now, the next few hours and the next few days for your town. |
| 5 · Visuals | The Basement sign, a 1930s lift dial that settles on B, a deco clock, the city at dusk, champagne bubbles and deco fans. |
| 6 · Games | Party games on the wall, with phones as the controllers (Colours and The Verdict included: the Games tab picks which). |
| 7 · Basement Live | Guests' phone cameras on the wall, up to four, cut together automatically. |
| 8 · Now Showing | Movie night: tonight's poster, a two-minute countdown, then the wall goes dark for the film. |
| 9 · The House Pour | Tonight's drinks as a 1930s hotel-bar card, and each drink you make, filling in its glass. |

Set leagues, news section, your town, the visual style and the bar's name under **Settings**
(or from the row under the walls while that channel is on). Scores, news and weather need the Pi
to be online.

(Internally the server has eleven channel ids: Colours and The Verdict have their own, `colours`
and `verdict`, which the remote shows as channel 6.)

Your own content (channel 1, under **Rotation**):

- **Photo/video:** pick from your phone. Photos are resized to each wall's exact pixel size
  on the Pi, with clean, sharp edges. Phone videos are converted on the Pi first, which can take a
  minute.
- **Text / Clock:** opens an editor with a live preview. Text sizes itself to fill the wall.
- **The switch on each piece:** puts it in the rotation; pieces take turns on channel 1. Set each
  one's time in its editor.
- **Show now:** pins one item over any channel until you press **Back to rotation** or
  **Back to channel**.
- **Message:** type it and it's on the walls straight away, held until you take it down (it
  isn't kept in the rotation).
- **Brightness** and **Blackout** apply to everything.

## Games

Pick a game on the **Games** tab (**Change game**) and press **Put … up**. Guests open **http://<pi-name>.local/play** on their
phones (same Wi-Fi), type a name and join. No app needed. Each game's own settings sit
on that tab, with who's in the room, **Invite** (a QR code for the join page) and **Sips**.
**End game** (two taps) puts the walls back on The Bar.

- **Brick Breaker:** slide on the phone to move the paddle. Gold bricks take two hits; catch the
  W, M and S capsules for a wide paddle, extra balls or a slower ball.
- **Deco Duel:** two players, one ball, first to 7. Play alone and the house plays you.
- **Serpentine:** everyone gets a snake. Eat cherries to grow; gold coins are worth three.
- **Quick Draw:** wait for DRAW, then tap first. Too early is a false start. First to 5 wins.
- **Closest Wins:** a question with a number answer goes up ("BURJ KHALIFA, METRES?") and
  everyone guesses on a big dial on their phone; the closest guess wins, so nobody needs to know
  the answer. The reveal drops everyone's dot onto a number line down the wall, furthest first,
  then the answer falls as a gold line. Closest gets 3, second 2, third 1, spot on 5. A round is
  six questions; before the sixth each phone can tap **DOUBLE** (twice the points if you place,
  lose 2 if you don't). Every third round is **WHAT YEAR?**: release years of songs and films.
  Questions don't repeat until a category has been used up (remembered in `data/used.json`).
- **Five Clues:** a hidden footballer, rapper, DJ, film, Dubai place or pop-culture name is
  revealed one clue at a time, hardest first. The first clue is worth 5, then 4, 3, 2 and 1 as
  an easier clue stacks under it every 6 seconds. Anyone can buzz: the first buzz to reach the
  Pi wins (buzzes in the 300 ms after a new clue are ignored, so nobody wins on a stale screen),
  the wall fills with that player's name and only their phone gets four options, with 8 seconds
  to pick. Right banks the points; wrong (or too slow) crosses their pick out, locks them out of
  that card and the clues carry on for everyone else. If nobody has it after clue 5, the answer
  shows and nobody scores. A round is six cards, one of each type. The cards are in
  `static/content/clues.json` (add your own in the same format) and don't repeat until a type
  has been used up.
- **Five Lights:** Never Have I Ever. Everyone starts with five gold bulbs. A prompt goes up
  ("NEVER HAVE I EVER / MISSED A FLIGHT") and every phone answers **I HAVE** or **NEVER** at once,
  changeable for 10 seconds. Then the wall says how many have ("3 OF 7 HAVE"), lights up their
  names and puts out one bulb each. Anyone who has can tap **Tell it** for 30 seconds of the wall.
  Every fifth prompt is a **Room** prompt: only the percentage shows, no names, no bulbs lost.
  Last one lit wins (if the last ones go out together they share it); **Relight** starts again.
  Pick the prompts before starting, on the control page or any phone in the lobby: **Mild**,
  **Dubai life** or **Cheeky** (the ceiling: nothing about bodies, money or exes). Players who are
  out keep answering for fun, and someone arriving mid-game comes in level with whoever has the
  fewest bulbs.
- **The Verdict:** a prompt about the room goes up ("WHO'S MOST LIKELY TO LOSE
  THEIR PHONE TONIGHT") and everyone votes in secret on their phone for someone who's there
  (never themselves). The wall reads the verdict like a jury: a gold bar per name rises a vote at a
  time, the light ones stop first, and the top name comes up in a deco frame, **GUILTY** with
  its votes, or **HUNG JURY** on a tie. Between prompts a quiet card shows the night's most
  convicted. Needs three players. Voting closes after 30 seconds, or as soon as everyone's in.
- **Colours:** for match nights. On the Games tab, open **Tonight's match** and pick it from
  the list (football from ESPN, tonight and tomorrow); that pins it and picks Colours (a games
  wall moves to it). The wall
  splits into the two clubs' colours, home on top and away below (darkened for a dim room; a
  near-black or clashing colour falls back to the club's second colour, then to gold against
  ivory), with a gold band between them. Guests pick **home**, **away** or **neutral** on their
  phones and their names go on that half (neutrals on the band). Before kickoff everyone can call
  the score (optional: +/- and Lock). The score on the wall comes only from the room: whoever sees
  a goal taps **GOAL**, so a delayed stream is never spoiled (taps for the same club within 45
  seconds count once, and **Disallowed** takes a goal back for 5 minutes). After a goal the
  scorers get a **TAP** button and the other side **SAVE** for 20 seconds; if the scorers push the
  band to the far edge, their colour floods the wall with their names. Switch **Tap war after a
  goal** off and a goal just floods the wall. When the match ends, someone taps **Full time** (or
  it settles itself 8 minutes after ESPN has the result): ESPN's result settles the calls, 3
  points for the exact score and 1 for the right result, into a season table kept in
  `data/colours.json` (a crown on the leader; **New season** clears it). The worst call gets the
  forfeit you set (default "LOSER POURS"). If ESPN can't be reached, the room's score stands 20
  minutes after Full time. The wall never shows ESPN's live score.

**Your own WHAT YEAR? questions.** With Closest Wins picked, open **What Year? questions** on the
Games tab and add one song or
film per line as `artist - title - year` (for example `Daft Punk - One More Time - 2000`). Each
line becomes a question, and yours go into WHAT YEAR? rounds first. They're saved in
`data/years.txt`, which you can also edit by hand.

**House prompts for Five Lights.** With Five Lights picked, open **House prompts** and add your group's own prompts, one
per line, the part after "Never have I ever" (40 letters at most). About one prompt in four is
one of yours. They're saved in `data/house.txt`.

**The Verdict, for the host.** When The Verdict is the game, the Games tab shows the deck (**Pre-party** or **Game night**, 80 prompts each, no repeats until a deck runs out),
the pace (**Auto**, a new prompt two minutes after the last went up, or **By hand**, when
anyone taps **Next verdict** on their phone) and, while it plays, **Next prompt** (or **Skip**) in the dock, which also skips the one on
the wall. Guests can **Write your own** on their phone between votes; it slides up on the remote with
their name, and nothing of theirs reaches the wall until you **Approve** it (**Reject** drops it
quietly). Approved ones go up next, marked FROM THE ROOM, without a name.

**Sips.** Off unless you switch on **Sips** (Games tab or Settings); it switches itself off at
6 am. While it's on, phones ask "Drinking tonight?" when they join (changeable on the phone any
time). Only people who said yes are ever given a sip, it's always one sip of anything (water
counts), and nothing escalates. The wall never shows who is or isn't drinking: a sip shows there
only as a small gold drop by a name, and on that person's phone. In Closest Wins the furthest
guess is a sip, and a spot-on guess lets you hand one to another drinker from your phone. In
Five Clues a wrong buzz is a sip, and getting it on the first clue lets you hand one out. In
Five Lights a bulb going out is a sip for a drinker (and just the bulb for everyone else); Room
prompts never cost anything. In The Verdict the convicted gets a sip (a hung jury, nobody).

### Building another party game

Quiz and vote games (Closest Wins, Five Clues, Five Lights, The Verdict and the ones to come) are
refereed by the Pi rather than the wall, so answers stay secret, scores are fair and every preview shows the same thing. The kit:

| Piece | Where | What it gives you |
| --- | --- | --- |
| `PartyGame` | `partygames.py` | Phases with timers (`go`), players by phone, round and night points, `podium()`, `award_sip()`, `offer_pour()` |
| `load_deck`, `UsedItems` | `partygames.py` | Decks from `static/content/<name>.json`; no repeats until a pool runs out, saved across restarts |
| Phone input | `GameHub.input` | `pick`, `number`, `lock`, `buzz`, `yesno`, `toggle`, `next`, `end`, `pour`, `suggest`, `tap {n}`, `call`, `goal`, `undo`, `fulltime`, `resume` (plus the arcade ones), checked before a game sees them |
| Phone pads | `static/play.html` | `wait`, `start` (with an optional row of settings), `number` (dial with hold-to-speed-up, drag strip, year mode), `pick` (2 x 2 or a list of names), `buzz`, `yesno`, `toggle`, `result`, `next`, `mash` (one huge button, taps batched), `call` and `goal` (Colours), plus a countdown bar, sip notes, the pour list and a box for writing your own prompt |
| Host controls | `PartyGame.host()`, `host_action()` | A game's own block on the remote's Games tab (`state.party`), and `POST /api/game/host` for its buttons (The Verdict's approvals) |
| Live data | `GameHub.poll` | A game with `wants(now)` / `fetched(ask, got)` gets internet data (Colours: ESPN) fetched off the game's lock every few seconds |
| Wall screens | `static/party.js` | Lobby, between-rounds card, podium, lock dots, countdown bar, sip drop, cached layers |

The top of `partygames.py` and `static/party.js` walks through adding a game step by step;
`ClosestWins` is the worked example (`FiveClues` a second one, with buzzing), and `test_party.py`
shows how to test one without a wall. `FiveLights` is a third; its wall lives in its own file
(`static/fivelights.js`). `Verdict` is the one with host controls on the remote, and
`test_colours.py` tests Colours with a stand-in for ESPN.

## Basement Live

Put a wall on channel 7. With nobody live it shows a QR code; guests scan it, type a name, choose
the front or back camera and press **Go live**. Up to four phones at once (a fifth is told the wall
is full). Picture only: no sound is sent.

The wall directs itself: one person fills the wall, with a slow push-in now and then. With two or
more, each takes a turn on the whole wall, with the occasional two stacked and, with three or four,
everyone at once. Someone new gets a short curtain reveal with their name. Each picture has a gold
frame and a small nameplate.

The same QR code is on the control page (tap channel 7, or the row under the walls), with Share
and Copy buttons.

**The secure link.** Phones only allow the camera on a secure (https) link, so the installer adds
a Cloudflare quick tunnel (free, no account): the `bar-screens-tunnel` service. It gives the Pi an
address like `https://some-random-words.trycloudflare.com`, which changes every time the Pi (or
the service) restarts; the wall and the control page always show the current one. The server reads
it from cloudflared's local metrics port (`127.0.0.1:3998/quicktunnel`), or failing that from the
service's log for its current run (`journalctl -u bar-screens-tunnel`). The Pi needs to be online.

Only the camera page is reachable through that link. Anything else that arrives through it (the
control page, uploads, settings) gets "403 Forbidden", so the remote stays on the home Wi-Fi.

The video goes straight from each phone to the Pi's display over WebRTC (with Google's public STUN
server to find the way); the server only passes the connection details along.

## Now Showing

Movie night on the walls. Tap channel 8 (**Now Showing**) on the control page, type the film and pick it
from the top five matches: its poster goes on the wall in a thin gold frame, with the title, year
and running time, turning every 20 seconds to a type-only card ("The Basement presents"). Then the
same sheet runs the night:

- **Start the feature:** a two-minute countdown, the gold curtains close, and the wall fades down
  to a faint gold line at about 4% for the whole film.
- **Intermission (5, 10 or 15 min):** the wall comes back up to about 40% with INTERMISSION, a
  gold ring that drains and "we resume in 9:41". When it runs out, the wall goes dark again by
  itself.
- **Resume:** back to the film early (during the countdown, it skips straight to dark).
- **The End:** THE END as a classic title card for 15 seconds, then back to The Bar. Mid-film it
  takes a second tap.

The buttons put every wall in use on channel 8. Anyone on the Wi-Fi can call an intermission from
**http://<pi-name>.local/film**, a small page with just those buttons.

Posters and details (year, running time) come from Wikipedia and Wikidata: free, no key, but the
Pi needs to be online the first time. Each film's poster and details are then kept in
`data/films/`, so a rewatch works with no internet (it's under **Shown before**). Sometimes
Wikipedia only has a still, or nothing; the wall then shows the type-only card, which is meant to
look that way.
## The House Pour

Channel 9 is the bar's card: **THE HOUSE POUR**, then three of tonight's drinks at a time in big
type, each beside a small gold glass, turning the page every few seconds. Ask what there is, point
at the wall.

When you make someone a drink, use the **Bar** tab on the control page: tap their name (or
**Someone else**), tap the drink and press **Pour**. The wall draws the drink's glass in gold (coupe, rocks,
highball, flute, martini, mug or wine glass) and fills it over about eight seconds in the drink's
own colour, with its float or foam, bubbles, ice and garnish, under **FOR SARAH** and above
**A NEGRONI**. Press **Served** for a short gold sunburst; a few seconds later the wall goes back to
the menu. One drink at a time, and nothing is counted.

If the wall is on channel 1 to 5 when you press Pour, the drink takes it over and the wall goes
back to that channel afterwards. A game or Basement Live is never interrupted.

**Tonight's menu** (**Change** on the Bar tab) starts with eight classics and mocktails ticked. Tick from
26 seeded drinks (`static/content/drinks.json`) or add your own with a name, a glass and a colour.

**Guests can ask from their phones** is off unless you switch it on. Then guests on
**http://<pi-name>.local/play** see tonight's menu and can ask for a drink; it slides up on the remote
with **Make it** and **Not now**, and their phone tells them how it's going. Nothing goes on the
wall without you.

## Live from your phone

On an iPhone, open **Control Centre**, tap **Screen Mirroring** and choose **The Basement**. Your
phone's screen shows on the wall (fitted inside it) until you stop mirroring, then the wall goes
back to its channel. Choose which wall and how it fits under **Settings › AirPlay** on the
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

- It adds background services called `bar-screens`, `bar-screens-airplay` (the AirPlay
  receiver) and `bar-screens-tunnel` (the secure link for Basement Live). It installs `ffmpeg`,
  `qrencode` and, if it isn't there yet, Cloudflare's `cloudflared`.
- It adds a startup entry that opens the display. The entry does nothing while Bar Screens is off.
- It sets the Pi to boot to the desktop and log in automatically, because the display needs the
  desktop.
- It turns off screen blanking.
- It uses port 80, or 8080 if something else already uses 80.

Uploads and settings live in `bar-screens/data/` (so do `years.txt` and `used.json`, the party
games' own question list and memory).

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
- **The wall says the secure link isn't ready.** Check the tunnel with
  `systemctl status bar-screens-tunnel` and `journalctl -u bar-screens-tunnel -n 30`. It needs the
  Pi to be online; restarting it (`sudo systemctl restart bar-screens-tunnel`) gets a new address.
- **A phone says the camera is blocked.** On an iPhone tap **aA** in Safari's address bar, then
  Website Settings > Camera > Allow. On Android tap the icon left of the address, then
  Permissions > Camera.
- **Anyone on your Wi-Fi can open the control page.** Keep that in mind if guests use your
  network.
