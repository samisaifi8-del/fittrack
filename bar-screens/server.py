#!/usr/bin/env python3
"""Bar Screens: drive the LED walls from a Raspberry Pi.

The Pi's HDMI output feeds the NovaStar TB6's HDMI IN. Chromium shows /display
full-screen, and any phone on the home Wi-Fi opens /control to change what's on
the walls. Standard library only, so it runs on a fresh Raspberry Pi OS.
"""

import argparse
import concurrent.futures
import datetime
import email.utils
import hashlib
import json
import mimetypes
import os
import queue
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlencode, urlparse

import partygames

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
MAX_UPLOAD = 2 * 1024 ** 3
MAX_JSON = 1024 ** 2
FONTS = ["Anton", "Poiret One", "Josefin Sans", "Bebas Neue", "Barlow Condensed", "Silkscreen", "VT323"]
FFMPEG = shutil.which("ffmpeg")
UXPLAY = shutil.which("uxplay")
QRENCODE = shutil.which("qrencode")
MIRROR_PORT = 7100  # where the AirPlay receiver sends its frames (see install.sh)
# The bar-screens-tunnel service (install.sh) runs a Cloudflare quick tunnel, which gives phones a
# trusted https link (they only allow the camera on https). Its address changes every time it
# starts; cloudflared reports the current one on its local metrics port.
TUNNEL_METRICS = "127.0.0.1:3998"
TUNNEL_UNIT = "bar-screens-tunnel"
# The Pi's own health, for the remote: its temperature from the kernel, its power from the firmware.
THERMAL_ZONE = "/sys/class/thermal/thermal_zone0/temp"
VCGENCMD = shutil.which("vcgencmd")
WARM_C, HOT_C = 70, 80  # the Pi 4 slows itself down from 80 °C

# Channel 1 is your own rotation; the rest are live channels drawn on the Pi from free data feeds.
CHANNELS = ["rotation", "scores", "news", "weather", "visuals", "games", "live", "nowshowing", "colours", "pour", "verdict"]
# Colours (9) and The Verdict (11) are party games with a channel of their own: tuning a wall to
# one picks that game, and picking it from a phone or the control page moves a game wall there.
GAME_CHANNELS = ("colours", "verdict")
LEAGUES = {  # ESPN's public scoreboard feed: no key needed, but it's unofficial and could change
    "eng.1": ("soccer/eng.1", "Premier League"),
    "eng.2": ("soccer/eng.2", "Championship"),
    "sco.1": ("soccer/sco.1", "Scottish Premiership"),
    "uefa.champions": ("soccer/uefa.champions", "Champions League"),
    "uefa.europa": ("soccer/uefa.europa", "Europa League"),
    "esp.1": ("soccer/esp.1", "La Liga"),
    "ita.1": ("soccer/ita.1", "Serie A"),
    "ger.1": ("soccer/ger.1", "Bundesliga"),
    "nfl": ("football/nfl", "NFL"),
    "nba": ("basketball/nba", "NBA"),
}
NEWS_FEEDS = {
    "top": ("https://feeds.bbci.co.uk/news/rss.xml", "Top stories"),
    "uk": ("https://feeds.bbci.co.uk/news/uk/rss.xml", "UK"),
    "scotland": ("https://feeds.bbci.co.uk/news/scotland/rss.xml", "Scotland"),
    "world": ("https://feeds.bbci.co.uk/news/world/rss.xml", "World"),
    "business": ("https://feeds.bbci.co.uk/news/business/rss.xml", "Business"),
    "tech": ("https://feeds.bbci.co.uk/news/technology/rss.xml", "Technology"),
    "entertainment": ("https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml", "Entertainment"),
    "sport": ("https://feeds.bbci.co.uk/sport/rss.xml", "Sport"),
}
VISUAL_STYLES = ["mix", "botanical", "deco", "lift", "clockface", "skyline", "bubbles", "fans"]
GAMES = [["breaker", "Brick Breaker"], ["duel", "Deco Duel"], ["snake", "Serpentine"], ["quickdraw", "Quick Draw"],
         ["closest", "Closest Wins"], ["fiveclues", "Five Clues"], ["fivelights", "Five Lights"], ["verdict", "The Verdict"],
         ["colours", "Colours"]]  # the last ones are party games the Pi referees (partygames.py)
# Now Showing (channel 8): film posters and details come from Wikipedia and Wikidata (free, no key).
# Wikimedia asks every client for a User-Agent that says what it is (one naming a bare HTTP library
# is throttled hard), and answers 429 to quick bursts, so searches are cached.
WIKI_UA = "BarScreens/1.0 (home cinema LED wall; Now Showing film posters)"
CINEMA_PHASES = ("idle", "poster", "countdown", "film", "intermission", "end")
COUNTDOWN = 120     # "Start the feature": two minutes to settle in
DIM_DOWN = 6        # then the curtains close and the wall goes dark (the wall times its own fades)
END_HOLD = 15       # THE END stays up this long, then the walls go back to The Bar
INTERMISSIONS = (5, 10, 15)
FILM_KEY = re.compile(r"[0-9]{1,12}")  # a Wikipedia page id
# The House Pour (channel 10): the seeded drinks, and what's on the menu until the host changes it.
DRINKS_FILE = os.path.join(STATIC, "content", "drinks.json")
GLASSES = ["coupe", "rocks", "highball", "flute", "martini", "mug", "wine"]
GARNISHES = ["orange", "lime", "lemon", "mint", "cherry", "olive", "none"]
TONIGHT = ["d001", "d002", "d004", "d003", "d006", "d007", "d021"]

for ext, ctype in ((".webp", "image/webp"), (".avif", "image/avif"), (".mp4", "video/mp4"),
                   (".m4v", "video/mp4"), (".webm", "video/webm"), (".mkv", "video/x-matroska")):
    mimetypes.add_type(ctype, ext)


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------- validation

def _num(lo, hi, integer=False):
    def check(v):
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError
        v = min(hi, max(lo, v))
        return int(round(v)) if integer else float(v)
    return check


def _bool(v):
    if not isinstance(v, bool):
        raise ValueError
    return v


def _str(maxlen):
    def check(v):
        if not isinstance(v, str):
            raise ValueError
        return v[:maxlen]
    return check


def _choice(*options):
    def check(v):
        if v not in options:
            raise ValueError
        return v
    return check


def _hex(v):
    if isinstance(v, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", v):
        return v.lower()
    raise ValueError


def _clean(patch, fields):
    if not isinstance(patch, dict):
        raise ApiError(400, "Expected a JSON object.")
    out = {}
    for key, value in patch.items():
        if key in fields:
            try:
                out[key] = fields[key](value)
            except ValueError:
                raise ApiError(400, f"Bad value for {key}.")
    return out


COMMON_FIELDS = {"name": _str(80), "duration": _num(2, 3600)}
MEDIA_FIELDS = {"fit": _choice("cover", "contain", "fill"), "bg": _hex,
                "posX": _num(0, 100, True), "posY": _num(0, 100, True)}
TEXT_FIELDS = {"text": _str(2000), "font": _choice(*FONTS), "color": _hex, "bg": _hex,
               "align": _choice("left", "center", "right"), "valign": _choice("top", "middle", "bottom"),
               "size": _num(20, 100, True), "outline": _bool, "crisp": _bool}
CLOCK_FIELDS = {"font": _choice(*FONTS), "color": _hex, "bg": _hex, "hour24": _bool,
                "showDate": _bool, "size": _num(20, 100, True), "crisp": _bool}
SLIDE_FIELDS = {
    "image": {**COMMON_FIELDS, **MEDIA_FIELDS},
    "video": {**COMMON_FIELDS, **MEDIA_FIELDS},
    "text": {**COMMON_FIELDS, **TEXT_FIELDS},
    "clock": {**COMMON_FIELDS, **CLOCK_FIELDS},
}
SLIDE_DEFAULTS = {
    "image": {"fit": "cover", "bg": "#000000", "posX": 50, "posY": 50, "duration": 10},
    "video": {"fit": "cover", "bg": "#000000", "posX": 50, "posY": 50, "duration": 20},
    "text": {"text": "HAPPY HOUR\n5–7 PM", "font": "Anton", "color": "#ffb000", "bg": "#000000",
             "align": "center", "valign": "middle", "size": 100, "outline": False, "crisp": True,
             "duration": 10},
    "clock": {"font": "Barlow Condensed", "color": "#ffffff", "bg": "#000000", "hour24": False,
              "showDate": True, "size": 100, "crisp": True, "duration": 10},
}
SCREEN_FIELDS = {"name": _str(40), "enabled": _bool,
                 "w": _num(8, 7680, True), "h": _num(8, 7680, True),
                 "x": _num(0, 7680, True), "y": _num(0, 7680, True),
                 "rw": _num(8, 7680, True), "rh": _num(8, 7680, True)}
SETTINGS_FIELDS = {"brightness": _num(5, 100, True), "blackout": _bool, "testPattern": _bool, "barName": _str(24),
                   "mirrorScreen": _choice("all", "s1", "s2"), "mirrorFit": _choice("contain", "cover")}
SCREEN_FIELDS["channel"] = _choice(*CHANNELS)


def default_channels():
    return {
        "scores": {"leagues": ["eng.1", "sco.1"]},
        "news": {"feed": "top"},
        "weather": {"place": "", "label": "", "lat": None, "lon": None},
        "visuals": {"style": "mix"},
        # sips are on for the night until sipsUntil; tier: Five Lights' prompts (partygames.TIERS);
        # The Verdict's deck and pace (auto: every 2 min); back: the game Games (6) goes back to
        # after Colours or The Verdict had the wall
        "games": {"game": "breaker", "sipsUntil": 0, "tier": "mild", "verdictDeck": "preparty", "verdictPace": "auto",
                  "back": "breaker"},
        # returns: screen id -> the channel it was on before the order on the wall took it over
        "pour": {"tonight": list(TONIGHT), "custom": [], "guestOrders": False, "returns": {}},
        # Colours (channel 9, a party game): the match the host pinned (ESPN's teams and colours,
        # kept so a restart doesn't need the internet), the forfeit line and the tap war after a goal
        "colours": {"pin": None, "forfeit": "LOSER POURS", "push": True},
    }


def default_screen(sid, name, enabled):
    # The Basement's TB6 is set up as one 256 x 384 screen (both walls show it). Start with that
    # area 1:1 at the top-left of the HDMI picture; Screen setup on the phone adjusts it.
    return {"id": sid, "name": name, "enabled": enabled, "w": 256, "h": 384,
            "x": 0, "y": 0, "rw": 256, "rh": 384, "channel": "rotation", "playlist": [], "pinned": None}


def default_cinema():
    # Now Showing: tonight's film (a key into the film cache) and where the night has got to.
    return {"film": None, "phase": "idle", "at": 0.0, "until": 0.0, "mins": 0}


def default_state():
    return {
        "settings": {"brightness": 100, "blackout": False, "testPattern": True, "barName": "THE BASEMENT",
                     "mirrorScreen": "all", "mirrorFit": "contain"},
        "screens": [default_screen("s1", "Left screen", True), default_screen("s2", "Right screen", False)],
        "slides": [],
        "channels": default_channels(),
        "cinema": default_cinema(),
    }


# ---------------------------------------------------------------- state

class Store:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.media_dir = os.path.join(data_dir, "media")
        os.makedirs(self.media_dir, exist_ok=True)
        self.path = os.path.join(data_dir, "state.json")
        # While this file exists, kiosk.sh keeps Chromium closed so the HDMI output is free for
        # whatever else the Pi is used for. The `bar-screens` command and the phone both toggle it.
        self.off_flag = os.path.join(data_dir, "display-off")
        self.lock = threading.RLock()
        self.clients = set()
        self.live = {}       # screen id -> {"slide", "index", "until"}; not saved
        self.display = None  # HDMI picture size reported by the display page
        self.mirroring = False  # a phone is mirroring to the wall over AirPlay
        self.live_info = dict   # Basement Live's link and cameras (set up in main)
        self.cinema_info = lambda: None  # Now Showing's film and phase, for phones and the wall
        self.pour_info = dict   # The House Pour's menu and the order on the wall (set up in main)
        self.drinks = load_drinks(DRINKS_FILE)
        self.party_info = lambda: None  # the party game's host view, e.g. guests' prompts to approve
        self.health_info = lambda: None  # the Pi's temperature and power (set up in main)
        self.state = self._load()
        for slide in self.state["slides"]:
            if slide.get("processing"):
                self._start_transcode(slide)
        self._advance(time.time())

    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            return default_state()
        except (OSError, ValueError):
            os.replace(self.path, self.path + f".broken-{int(time.time())}")
            return default_state()
        state = default_state()
        state["settings"].update({k: v for k, v in data.get("settings", {}).items() if k in state["settings"]})
        saved = {s.get("id"): s for s in data.get("screens", []) if isinstance(s, dict)}
        for screen in state["screens"]:
            screen.update({k: v for k, v in saved.get(screen["id"], {}).items() if k in screen})
        state["slides"] = [s for s in data.get("slides", []) if isinstance(s, dict) and s.get("type") in SLIDE_FIELDS]
        for name, conf in state["channels"].items():
            saved_conf = data.get("channels", {}).get(name)
            if isinstance(saved_conf, dict):
                conf.update({k: v for k, v in saved_conf.items() if k in conf})
        cinema = data.get("cinema")
        if isinstance(cinema, dict) and cinema.get("phase") in CINEMA_PHASES:
            film = cinema.get("film")
            state["cinema"] = {"film": film if isinstance(film, str) and FILM_KEY.fullmatch(film) else None,
                               "phase": cinema["phase"], "mins": cinema.get("mins") if cinema.get("mins") in INTERMISSIONS else 0,
                               **{k: float(cinema[k]) if isinstance(cinema.get(k), (int, float)) else 0.0 for k in ("at", "until")}}
            if not state["cinema"]["film"]:
                state["cinema"]["phase"] = "idle"
        return state

    def save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.state, f, indent=1)
        os.replace(tmp, self.path)

    # -- live updates

    def snapshot(self):
        with self.lock:
            return json.dumps({
                **self.state,
                "live": {sid: {"slide": v["slide"], "channel": v["channel"]} for sid, v in self.live.items()},
                "display": self.display,
                "displayOn": not os.path.exists(self.off_flag),
                "mirror": {"available": bool(UXPLAY), "live": self.mirroring},
                "golive": self.live_info(),
                "cinema": self.cinema_info(),
                "bar": self.pour_info(),
                "party": self.party_info(),
                "health": self.health_info(),
                "ffmpeg": bool(FFMPEG),
                "catalog": {
                    "leagues": [[k, v[1]] for k, v in LEAGUES.items()],
                    "feeds": [[k, v[1]] for k, v in NEWS_FEEDS.items()],
                    "styles": VISUAL_STYLES,
                    "games": GAMES,
                    "drinks": self.drinks,
                    "glasses": GLASSES,
                },
            })

    def subscribe(self):
        q = queue.Queue(maxsize=50)
        with self.lock:
            self.clients.add(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            self.clients.discard(q)

    def _broadcast(self):
        msg = self.snapshot()
        for q in list(self.clients):
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass

    def refresh(self):
        with self.lock:
            self._broadcast()

    def _changed(self, save=True):
        if save:
            self.save()
        self._advance(time.time())
        self._broadcast()

    # -- rotation

    def _advance(self, now, force=None):
        """Pick what each screen shows: its pinned slide, or the next one in its rotation."""
        changed = False
        slides = {s["id"]: s for s in self.state["slides"]}
        for screen in self.state["screens"]:
            live = self.live.setdefault(screen["id"], {"slide": None, "channel": None, "index": -1, "until": 0.0})
            if screen["pinned"] in slides:
                if live["slide"] != screen["pinned"] or live["channel"]:
                    live.update(slide=screen["pinned"], channel=None, until=0.0)
                    changed = True
                continue
            if screen.get("channel", "rotation") != "rotation":
                if live["slide"] is not None or live["channel"] != screen["channel"]:
                    live.update(slide=None, channel=screen["channel"], until=0.0)
                    changed = True
                continue
            if live["channel"]:
                live["channel"] = None
                changed = True
            rotation = [i for i in screen["playlist"] if i in slides and not slides[i].get("processing")]
            if not rotation:
                if live["slide"] is not None:
                    live.update(slide=None, index=-1, until=0.0)
                    changed = True
                continue
            current = live["slide"]
            if current in rotation and force != screen["id"] and (now < live["until"] or len(rotation) == 1):
                continue
            if current in rotation:
                index = (rotation.index(current) + 1) % len(rotation)
            else:
                index = live["index"] % len(rotation) if live["index"] >= 0 else 0
            nxt = rotation[index]
            live.update(slide=nxt, index=index, until=now + float(slides[nxt].get("duration") or 10))
            changed = changed or nxt != current
        return changed

    def tick(self):
        with self.lock:
            if self._advance(time.time()):
                self._broadcast()

    # -- slides

    def _slide(self, slide_id):
        for slide in self.state["slides"]:
            if slide["id"] == slide_id:
                return slide
        raise ApiError(404, "That item no longer exists.")

    def _screen(self, screen_id):
        for screen in self.state["screens"]:
            if screen["id"] == screen_id:
                return screen
        raise ApiError(404, "Unknown screen.")

    def _place(self, slide, add_to=None, pin_to=None):
        for screen in self.state["screens"]:
            if screen["id"] == add_to and slide["id"] not in screen["playlist"]:
                screen["playlist"].append(slide["id"])
            if screen["id"] == pin_to:
                screen["pinned"] = slide["id"]

    def create_slide(self, body):
        kind = body.get("type")
        if kind not in ("text", "clock"):
            raise ApiError(400, "Only text and clock items can be created this way.")
        props = _clean(body, SLIDE_FIELDS[kind])
        default_name = "Clock" if kind == "clock" else (props.get("text") or "Text").strip().split("\n")[0][:40]
        slide = {"id": uuid.uuid4().hex[:10], "type": kind, "name": default_name,
                 "created": time.time(), **SLIDE_DEFAULTS[kind], **props}
        with self.lock:
            self.state["slides"].append(slide)
            self._place(slide, body.get("addTo"), body.get("pinTo"))
            self._changed()
        return slide

    def add_media(self, kind, filename, display_name, add_to=None):
        slide = {"id": uuid.uuid4().hex[:10], "type": kind, "name": display_name[:80], "file": filename,
                 "created": time.time(), **SLIDE_DEFAULTS[kind]}
        if kind == "video" and FFMPEG:
            slide["processing"] = True
        with self.lock:
            self.state["slides"].append(slide)
            self._place(slide, add_to)
            self._changed()
        if slide.get("processing"):
            self._start_transcode(slide)
        return slide

    def update_slide(self, slide_id, patch):
        with self.lock:
            slide = self._slide(slide_id)
            slide.update(_clean(patch, SLIDE_FIELDS[slide["type"]]))
            self._changed()
            return slide

    def delete_slide(self, slide_id):
        with self.lock:
            slide = self._slide(slide_id)
            self.state["slides"].remove(slide)
            for screen in self.state["screens"]:
                screen["playlist"] = [i for i in screen["playlist"] if i != slide_id]
                if screen["pinned"] == slide_id:
                    screen["pinned"] = None
            self._changed()
            if slide.get("file") and not any(s.get("file") == slide["file"] for s in self.state["slides"]):
                self._remove_media(slide["file"])

    def _remove_media(self, name):
        try:
            os.remove(os.path.join(self.media_dir, name))
        except OSError:
            pass

    # -- screens and settings

    def update_screen(self, screen_id, patch):
        with self.lock:
            screen = self._screen(screen_id)
            screen.update(_clean(patch, SCREEN_FIELDS))
            ids = {s["id"] for s in self.state["slides"]}
            if "playlist" in patch:
                if not isinstance(patch["playlist"], list):
                    raise ApiError(400, "Bad value for playlist.")
                seen = []
                for i in patch["playlist"]:
                    if i in ids and i not in seen:
                        seen.append(i)
                screen["playlist"] = seen
            if "pinned" in patch:
                screen["pinned"] = patch["pinned"] if patch["pinned"] in ids else None
            if "channel" in patch:
                games = self.state["channels"]["games"]
                if screen["channel"] in GAME_CHANNELS:
                    self._pick_game(screen["channel"])
                elif screen["channel"] == "games" and games["game"] in GAME_CHANNELS:
                    games["game"] = games["back"] if games["back"] not in GAME_CHANNELS else "breaker"
                self._follow_game()
            self._changed()
            return screen

    def _pick_game(self, game):
        games = self.state["channels"]["games"]
        if game in GAME_CHANNELS and games["game"] not in GAME_CHANNELS:
            games["back"] = games["game"]
        games["game"] = game

    def _follow_game(self):
        """Every wall on a game channel goes to the one for the game that's picked: Colours and The
        Verdict have their own (9 and 11), every other game is on Games (6)."""
        game = self.state["channels"]["games"]["game"]
        want = game if game in GAME_CHANNELS else "games"
        for screen in self.state["screens"]:
            if screen.get("channel") in ("games",) + GAME_CHANNELS:
                screen["channel"] = want

    def next_slide(self, screen_id):
        with self.lock:
            screen = self._screen(screen_id)
            screen["pinned"] = None
            self.save()
            self._advance(time.time(), force=screen_id)
            self._broadcast()

    def update_settings(self, patch):
        with self.lock:
            if "displayOn" in patch:
                if not isinstance(patch["displayOn"], bool):
                    raise ApiError(400, "Bad value for displayOn.")
                if patch["displayOn"]:
                    try:
                        os.remove(self.off_flag)
                    except FileNotFoundError:
                        pass
                else:
                    open(self.off_flag, "a").close()
            self.state["settings"].update(_clean(patch, SETTINGS_FIELDS))
            self._changed()

    def update_channels(self, patch):
        if not isinstance(patch, dict):
            raise ApiError(400, "Expected a JSON object.")
        found = None
        weather = patch.get("weather")
        if isinstance(weather, dict) and "place" in weather:
            place = _str(80)(weather["place"]).strip()
            found = geocode(place) if place else {"place": "", "label": "", "lat": None, "lon": None}
        pinned = None  # Colours: the match to pin ({} to unpin), looked up on ESPN first
        colours = patch.get("colours")
        if isinstance(colours, dict) and "pin" in colours:
            pin = colours["pin"]
            if pin is None:
                pinned = {}
            elif isinstance(pin, dict) and pin.get("league") in SOCCER and re.fullmatch(r"\d{1,12}", str(pin.get("id", ""))):
                try:
                    pinned = find_match(pin["league"], str(pin["id"]), pin.get("date") if isinstance(pin.get("date"), str) else None)
                except Exception:
                    pinned = None
                if not pinned:
                    raise ApiError(502, "Couldn't find that match on ESPN. Check the Pi is online and try again.")
                for side in ("home", "away"):
                    pinned[side].pop("score", None)  # the wall's score comes only from the room
            else:
                raise ApiError(400, "Bad match.")
        with self.lock:
            conf = self.state["channels"]
            scores = patch.get("scores")
            if isinstance(scores, dict) and isinstance(scores.get("leagues"), list):
                conf["scores"]["leagues"] = [k for k in LEAGUES if k in scores["leagues"]]
            news = patch.get("news")
            if isinstance(news, dict) and news.get("feed") in NEWS_FEEDS:
                conf["news"]["feed"] = news["feed"]
            visuals = patch.get("visuals")
            if isinstance(visuals, dict) and visuals.get("style") in VISUAL_STYLES:
                conf["visuals"]["style"] = visuals["style"]
            games = patch.get("games")
            if isinstance(games, dict) and games.get("game") in [g[0] for g in GAMES]:
                self._pick_game(games["game"])
            if isinstance(games, dict) and isinstance(games.get("sips"), bool):
                conf["games"]["sipsUntil"] = partygames.sips_until(time.time()) if games["sips"] else 0
            if isinstance(games, dict) and games.get("tier") in partygames.TIERS:
                conf["games"]["tier"] = games["tier"]
            if isinstance(games, dict) and games.get("verdictDeck") in partygames.Verdict.DECKS:
                conf["games"]["verdictDeck"] = games["verdictDeck"]
            if isinstance(games, dict) and games.get("verdictPace") in ("auto", "hand"):
                conf["games"]["verdictPace"] = games["verdictPace"]
            colours = patch.get("colours")
            if isinstance(colours, dict):
                if isinstance(colours.get("forfeit"), str):
                    conf["colours"]["forfeit"] = " ".join(_str(32)(colours["forfeit"]).split()).upper() or "LOSER POURS"
                if isinstance(colours.get("push"), bool):
                    conf["colours"]["push"] = colours["push"]
                if pinned is not None:
                    conf["colours"]["pin"] = pinned or None
                    if pinned:
                        self._pick_game("colours")  # pinning a match is asking for Colours
            if found is not None:
                conf["weather"] = found
            self._follow_game()
            self._changed()
            return conf

    def set_mirroring(self, live):
        with self.lock:
            if self.mirroring != live:
                self.mirroring = live
                self._broadcast()

    def set_display(self, info):
        clean = _clean(info, {"w": _num(1, 16384, True), "h": _num(1, 16384, True)})
        if set(clean) != {"w", "h"}:
            raise ApiError(400, "Expected w and h.")
        with self.lock:
            if self.display != clean:
                self.display = clean
                self._broadcast()

    # -- video conversion

    def _start_transcode(self, slide):
        threading.Thread(target=self._transcode, args=(slide["id"], slide["file"]), daemon=True).start()

    def _transcode(self, slide_id, src_name):
        """Re-encode phone videos (often HEVC, which Chromium on the Pi can't play) to H.264."""
        src = os.path.join(self.media_dir, src_name)
        base = os.path.splitext(src_name)[0]
        out_name = base + "-h264.mp4"
        out = os.path.join(self.media_dir, out_name)
        ok = False
        if FFMPEG and os.path.exists(src):
            cmd = [FFMPEG, "-y", "-v", "error", "-i", src, "-map", "0:v:0", "-an",
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
                   "-vf", "scale='trunc(min(1920,iw)/2)*2':-2", "-movflags", "+faststart", out + ".part.mp4"]
            if shutil.which("nice"):
                cmd = ["nice", "-n", "10"] + cmd
            try:
                ok = subprocess.run(cmd, timeout=3600, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
            except (OSError, subprocess.SubprocessError):
                ok = False
            if ok:
                os.replace(out + ".part.mp4", out)
            else:
                try:
                    os.remove(out + ".part.mp4")
                except OSError:
                    pass
        with self.lock:
            slide = next((s for s in self.state["slides"] if s["id"] == slide_id), None)
            if slide is None:
                if ok:
                    self._remove_media(out_name)
                return
            slide.pop("processing", None)
            if ok:
                slide["file"] = out_name
                slide.pop("error", None)
                self._remove_media(src_name)
            else:
                slide["error"] = "This video couldn't be converted, so it may not play."
            self._changed()


# ---------------------------------------------------------------- live data feeds

def fetch_url(url, timeout=8, ua="BarScreens/1.0 (home LED display)"):
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read(5 * 1024 * 1024)


def geocode(place):
    try:
        data = json.loads(fetch_url("https://geocoding-api.open-meteo.com/v1/search?" +
                                    urlencode({"name": place, "count": 1, "language": "en", "format": "json"})))
    except Exception:
        raise ApiError(502, "Couldn't look that place up. Check the Pi is connected to the internet.")
    results = data.get("results") or []
    if not results:
        raise ApiError(404, f"Couldn't find \"{place}\". Try a nearby town or city.")
    r = results[0]
    region = r.get("admin1") or r.get("country") or ""
    return {"place": place, "label": r.get("name", place), "region": region,
            "lat": r["latitude"], "lon": r["longitude"]}


def _hexcolor(v):
    return "#" + v.lower() if isinstance(v, str) and re.fullmatch(r"[0-9a-fA-F]{6}", v) else None


# Pictures on the walls (Scores' club crests from ESPN, News' story photos from the BBC) come
# through the Pi (/api/image), which keeps a copy, so the wall never waits on a picture it has
# shown before. Only these two image servers are fetched from; news photos older than a few days
# are cleared out.
CREST_URL = re.compile(r"https://a\.espncdn\.com/i/teamlogos/[a-z0-9/_-]+\.png", re.I)
NEWS_IMAGE_URL = re.compile(r"https://ichef\.bbci\.co\.uk/[a-z0-9/_-]+\.(?:jpg|jpeg|png)", re.I)
IMAGE_KEEP_DAYS = 3


def image_file(data_dir, url):
    """The picture's file on the Pi, fetched once. None for anything not from ESPN's crests or the BBC."""
    if not isinstance(url, str) or not (CREST_URL.fullmatch(url) or NEWS_IMAGE_URL.fullmatch(url)):
        return None
    folder = os.path.join(data_dir, "images")
    os.makedirs(folder, exist_ok=True)
    ext = os.path.splitext(url)[1].lower()
    path = os.path.join(folder, hashlib.sha1(url.encode()).hexdigest()[:20] + ext)
    if not os.path.exists(path):
        data = fetch_url(url)
        if not (data.startswith(b"\x89PNG") or data.startswith(b"\xff\xd8")):
            raise IOError("not a picture")
        tmp = f"{path}.{threading.get_ident()}.part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
        _prune_images(folder)
    return path


def _prune_images(folder):
    """News photos go stale; crests are kept (there are only so many clubs)."""
    cutoff = time.time() - IMAGE_KEEP_DAYS * 86400
    for name in os.listdir(folder):
        full = os.path.join(folder, name)
        try:
            if name.endswith((".jpg", ".jpeg")) and os.path.getmtime(full) < cutoff:
                os.remove(full)
        except OSError:
            pass


def _team(competitor):
    t = competitor.get("team") or {}
    logo = t.get("logo")
    return {
        "abbr": (t.get("abbreviation") or t.get("shortDisplayName") or "?")[:4].upper(),
        "name": t.get("shortDisplayName") or t.get("displayName") or "",
        "score": str(competitor.get("score") or ""),
        "color": _hexcolor(t.get("color")),
        "alt": _hexcolor(t.get("alternateColor")),
        "logo": logo if isinstance(logo, str) and CREST_URL.fullmatch(logo) else None,
    }


def _match_events(comp, sides):
    """Goals and red cards, oldest first: {"side": "home"|"away", "min": "16'", "who": "K. Havertz",
    "kind": "goal"|"pen"|"og"|"red"}. ESPN lists them under the competition's details."""
    side_of = {(c.get("team") or {}).get("id"): k for k, c in sides.items()}
    events = []
    for d in comp.get("details") or []:
        side = side_of.get((d.get("team") or {}).get("id"))
        if not side:
            continue
        if d.get("scoringPlay"):
            kind = "og" if d.get("ownGoal") else "pen" if d.get("penaltyKick") else "goal"
        elif d.get("redCard"):
            kind = "red"
        else:
            continue
        who = next((a.get("shortName") or (a.get("athlete") or {}).get("shortName") or a.get("displayName")
                    for a in d.get("athletesInvolved") or [] if isinstance(a, dict)), "") or ""
        events.append({"side": side, "min": str((d.get("clock") or {}).get("displayValue") or "")[:8],
                       "who": who[:24], "kind": kind})
    return events[:16]


def fetch_scores(conf):
    today = datetime.date.today()
    span = f"{today - datetime.timedelta(days=1):%Y%m%d}-{today + datetime.timedelta(days=6):%Y%m%d}"
    leagues, failures = [], 0
    for key in conf.get("leagues", []):
        if key not in LEAGUES:
            continue
        path, title = LEAGUES[key]
        try:
            url = f"https://site.api.espn.com/apis/site/v2/sports/{path}/scoreboard"
            try:
                data = json.loads(fetch_url(f"{url}?dates={span}&limit=200"))
            except Exception:  # ESPN stopped taking date ranges (Oct 2026): then just this week's games
                data = json.loads(fetch_url(url))
        except Exception:
            failures += 1
            continue
        matches = []
        for ev in data.get("events", []):
            comp = (ev.get("competitions") or [{}])[0]
            sides = {c.get("homeAway"): c for c in comp.get("competitors", [])}
            if "home" not in sides or "away" not in sides:
                continue
            status = comp.get("status") or ev.get("status") or {}
            kind = status.get("type") or {}
            matches.append({
                "date": ev.get("date") or comp.get("date"),
                "state": kind.get("state", "pre"),
                "detail": kind.get("shortDetail", ""),
                "clock": status.get("displayClock", ""),
                "home": _team(sides["home"]),
                "away": _team(sides["away"]),
                "venue": str((comp.get("venue") or {}).get("fullName") or "")[:40],
                "events": _match_events(comp, sides),
            })
        leagues.append({"key": key, "name": title, "matches": matches})
    if failures and not leagues:
        raise IOError("scores unavailable")
    return {"leagues": leagues}


# Colours (partygames.py) needs one football match at a time: tonight's list for the host to pin
# from, then that match's kickoff and full-time result. ESPN answers 400 to a date range, so these
# ask for one day at a time (or no date: its current matchday).
SOCCER = {k: v for k, v in LEAGUES.items() if v[0].startswith("soccer/")}


def espn_board(league, date=None):
    """One league's ESPN scoreboard for one day (a date) or its current matchday (None), as
    matches: [{id, league, leagueName, date, state, completed, detail, home, away}]."""
    path, title = SOCCER[league]
    url = f"https://site.api.espn.com/apis/site/v2/sports/{path}/scoreboard" + (f"?dates={date:%Y%m%d}" if date else "")
    data = json.loads(fetch_url(url))
    out = []
    for ev in data.get("events", []):
        comp = (ev.get("competitions") or [{}])[0]
        sides = {c.get("homeAway"): c for c in comp.get("competitors", [])}
        if "home" not in sides or "away" not in sides or not ev.get("id"):
            continue
        kind = ((comp.get("status") or ev.get("status") or {}).get("type") or {})
        out.append({
            "id": str(ev["id"]), "league": league, "leagueName": title, "date": ev.get("date") or comp.get("date"),
            "state": kind.get("state", "pre"), "completed": bool(kind.get("completed")),
            "detail": kind.get("shortDetail", ""), "home": _team(sides["home"]), "away": _team(sides["away"]),
        })
    return out


def _kickoff(m):
    try:
        return datetime.datetime.fromisoformat((m.get("date") or "").replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0


def find_match(league, event_id, date=None):
    """One match by ESPN id, or None. `date` (its ISO kickoff, if known) says which days to ask."""
    days = [None]
    try:
        k = datetime.datetime.fromisoformat((date or "").replace("Z", "+00:00"))
        days += [k.date(), k.date() - datetime.timedelta(days=1), k.date() + datetime.timedelta(days=1)]
    except ValueError:
        today = datetime.date.today()
        days += [today, today + datetime.timedelta(days=1)]
    failures = 0
    for day in days:
        try:
            hit = next((m for m in espn_board(league, day) if m["id"] == event_id), None)
        except Exception:
            failures += 1
            continue
        if hit:
            return hit
    if failures == len(days):
        raise IOError("ESPN unavailable")
    return None


_tonight = {"at": 0, "matches": []}


def tonight_matches():
    """Football on tonight and tomorrow in every league ESPN gives us, soonest first, for the host
    to pin one for Colours. Asked in parallel and kept for five minutes (one, if there were none)."""
    if time.time() - _tonight["at"] < (300 if _tonight["matches"] else 60):
        return _tonight["matches"]
    today = datetime.date.today()
    asks = [(k, d) for k in SOCCER for d in (None, today, today + datetime.timedelta(days=1))]
    found, failures = {}, 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for fut in [pool.submit(espn_board, k, d) for k, d in asks]:
            try:
                for m in fut.result():
                    found[m["id"]] = m
            except Exception:
                failures += 1
    if failures == len(asks):
        raise ApiError(502, "Couldn't reach ESPN for tonight's matches. Check the Pi is online.")
    now = time.time()
    matches = sorted((m for m in found.values() if now - 3 * 3600 < _kickoff(m) < now + 36 * 3600 and not m["completed"]), key=_kickoff)
    for m in matches:
        for side in ("home", "away"):
            m[side].pop("score", None)  # the room keeps its own score: no spoilers on any screen
    _tonight.update(at=now, matches=matches)
    return matches


MEDIA_NS = "{http://search.yahoo.com/mrss/}"


def _news_image(item):
    """The story's photo at a size the walls can use: the BBC's 240 px thumbnail, asked for at 480."""
    thumb = item.find(MEDIA_NS + "thumbnail")
    url = thumb.get("url") if thumb is not None else None
    if not url or not NEWS_IMAGE_URL.fullmatch(url):
        return None
    return re.sub(r"/standard/\d+/", "/standard/480/", url, count=1)


def _rss_time(text):
    """An RSS date ("Mon, 02 Nov 2026 14:11:13 GMT") as ISO 8601, or None."""
    try:
        return email.utils.parsedate_to_datetime(text).isoformat()
    except (TypeError, ValueError, IndexError):
        return None


def fetch_news(conf):
    url, section = NEWS_FEEDS.get(conf.get("feed"), NEWS_FEEDS["top"])
    root = ET.fromstring(fetch_url(url))
    items = []
    for item in root.iter("item"):
        title = " ".join((item.findtext("title") or "").split())
        if title and title not in (i["title"] for i in items):
            items.append({"title": title, "summary": " ".join((item.findtext("description") or "").split())[:240],
                          "image": _news_image(item), "time": _rss_time(item.findtext("pubDate"))})
        if len(items) >= 20:
            break
    if not items:
        raise IOError("no headlines")
    return {"source": "BBC News", "section": section, "items": items}


def fetch_weather(conf):
    if conf.get("lat") is None:
        return {"needsPlace": True}
    query = urlencode({
        "latitude": conf["lat"], "longitude": conf["lon"], "timezone": "auto", "forecast_days": 5,
        "wind_speed_unit": "mph",
        "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day,cloud_cover",
        "hourly": "temperature_2m,weather_code,precipitation_probability",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
    })
    d = json.loads(fetch_url("https://api.open-meteo.com/v1/forecast?" + query))
    cur, hourly, daily = d["current"], d.get("hourly", {}), d.get("daily", {})
    times = hourly.get("time", [])
    start = next((i for i, t in enumerate(times) if t >= cur["time"][:13]), 0)
    hours = [{"time": times[i][11:16], "temp": hourly["temperature_2m"][i], "code": hourly["weather_code"][i],
              "rain": (hourly.get("precipitation_probability") or [None] * len(times))[i]}
             for i in range(start + 3, min(start + 13, len(times)), 3)]
    days = [{"date": day, "code": daily["weather_code"][i], "max": daily["temperature_2m_max"][i],
             "min": daily["temperature_2m_min"][i]}
            for i, day in enumerate(daily.get("time", []))]
    # the sky on the wall follows the town's own day: its sunrise and sunset today (minutes after
    # its midnight) and how far its clock is from UTC
    sun = {k: _minutes(((daily.get(k) or [None])[0] or "")[11:16]) for k in ("sunrise", "sunset")}
    return {"place": conf.get("label", ""),
            "now": {"temp": cur["temperature_2m"], "feels": cur.get("apparent_temperature"),
                    "code": cur["weather_code"], "wind": cur.get("wind_speed_10m"), "day": bool(cur.get("is_day", 1)),
                    "cloud": cur.get("cloud_cover")},
            "sun": {"rise": sun["sunrise"], "set": sun["sunset"]}, "utcOffset": d.get("utc_offset_seconds", 0),
            "hours": hours, "days": days}


def _minutes(hhmm):
    """ "06:22" -> 382, or None."""
    m = re.fullmatch(r"(\d{2}):(\d{2})", hhmm or "")
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


class Feeds:
    """Fetches live data for the channels on the Pi and caches it, so every screen and preview
    shares one request and a dropped connection just keeps showing the last good data."""
    SOURCES = {"scores": (fetch_scores, 60), "news": (fetch_news, 300), "weather": (fetch_weather, 600)}

    def __init__(self, store):
        self.store = store
        self.cache = {}
        self.locks = {name: threading.Lock() for name in self.SOURCES}

    def get(self, name):
        fetch, ttl = self.SOURCES[name]
        with self.store.lock:
            conf = json.loads(json.dumps(self.store.state["channels"][name]))
        key = json.dumps(conf, sort_keys=True)
        with self.locks[name]:
            entry = self.cache.get(name)
            if entry and entry["key"] == key and time.time() < entry["expires"]:
                return entry["payload"]
            try:
                payload = {"ok": True, "updated": time.time(), "data": fetch(conf)}
                expires = time.time() + ttl
            except Exception:
                old = entry["payload"]["data"] if entry and entry["key"] == key else None
                payload = {"ok": False, "updated": entry["payload"]["updated"] if old else None, "data": old}
                expires = time.time() + 30
            self.cache[name] = {"key": key, "payload": payload, "expires": expires}
            return payload


# ---------------------------------------------------------------- live from a phone

class Mirror:
    """Frames from the AirPlay receiver. UxPlay (installed by install.sh) decodes what a phone
    mirrors and sends it here as a stream of JPEGs; the display shows them inside each wall's own
    area, which a full-screen AirPlay window couldn't do."""

    def __init__(self, port):
        self.port = port
        self.frame = None
        self.at = 0.0
        self.cond = threading.Condition()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        while True:
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=5) as sock:
                    sock.settimeout(5)
                    buf = b""
                    while True:
                        try:
                            chunk = sock.recv(256 * 1024)
                        except socket.timeout:
                            continue
                        if not chunk:
                            break
                        buf += chunk
                        while True:
                            start = buf.find(b"\xff\xd8")
                            if start < 0:
                                buf = buf[-1:]
                                break
                            end = buf.find(b"\xff\xd9", start + 2)
                            if end < 0:
                                buf = buf[start:]
                                break
                            with self.cond:
                                self.frame = buf[start:end + 2]
                                self.at = time.time()
                                self.cond.notify_all()
                            buf = buf[end + 2:]
                        if len(buf) > 16 * 1024 * 1024:
                            buf = b""
            except OSError:
                pass
            time.sleep(2)

    @property
    def live(self):
        return self.frame is not None and time.time() - self.at < 2.5

    def next_frame(self, after, timeout=5):
        with self.cond:
            self.cond.wait_for(lambda: self.at != after, timeout=timeout)
            return self.frame, self.at


# ---------------------------------------------------------------- games

class GameHub:
    """Phones join the current game and send controller input; the wall runs the game and reports
    the score back. Players are kept while their phone stays connected (with a short grace period
    for flaky Wi-Fi), so nothing here is saved to disk.

    Party games (quiz and vote games, partygames.py) are refereed here instead: their input goes
    to the game on the Pi, and the hub sends the wall its view and each phone its own one."""
    COLORS = ["#e9c46a", "#2fd39a", "#5aa2ff", "#ff4d6a", "#b98aff", "#ffa94d", "#efe6d2", "#5ef0ff"]
    clock = staticmethod(time.time)
    espn = staticmethod(find_match)  # a party game's live data (Colours: its pinned match)
    PARKED_FOR = 30 * 60  # a party game left for longer than this starts again from its lobby

    def __init__(self, store):
        self.store = store
        self.lock = threading.Lock()
        self.players = {}  # pid -> {"slot", "name", "color", "drinks", "gone"}
        self.subs = []     # [queue, role, pid]
        self.status = None
        self.kiosk_at = 0.0
        self.join_url = ""
        self.used = partygames.UsedItems(os.path.join(store.data_dir, "used.json"))
        self.party = None  # the party game being refereed, if one is picked
        self.parked = {}   # game key -> (party game, when it was left): tuning 6 <-> 9/11 resumes it
        self.party_sent = -1
        self.later = []    # a game's calls into the Store, run once this hub's lock is let go
        self._sync_party()

    def sips_on(self):
        """Whether the host has switched sips on for tonight (control page, Channel settings)."""
        return self.store.state["channels"]["games"].get("sipsUntil", 0) > self.clock()

    def _sync_party(self):
        game = self.store.state["channels"]["games"]["game"]
        cls = partygames.PARTY_GAMES.get(game)
        self.party_sent = -1
        if type(self.party) is cls:
            return
        if self.party:  # kept, so a trip to another game and back picks up where it was
            self.parked[self.party.key] = (self.party, self.clock())
        kept, left = self.parked.pop(game, (None, 0))
        if cls is None:
            self.party = None
        elif type(kept) is cls and self.clock() - left < self.PARKED_FOR:
            self.party = kept
            kept.changed()
        else:
            self.party = cls(self)

    def _roster(self):
        game = self.store.state["channels"]["games"]["game"]
        players = sorted(self.players.values(), key=lambda p: p["slot"])
        on_wall = any(s["enabled"] and s.get("channel") in ("games",) + GAME_CHANNELS for s in self.store.state["screens"])
        return {"type": "roster", "game": game, "joinUrl": self.join_url, "joinQr": qr_matrix(join_link(self.join_url)),
                "onWall": on_wall,
                "party": self.party is not None, "sips": self.sips_on(),
                "players": [{"slot": p["slot"], "name": p["name"], "color": p["color"]} for p in players]}

    def after(self, fn):
        """For a game: call into the Store (fn) once the hub's lock is let go. The Store's snapshot
        asks this hub for its players' names (The House Pour) under the Store's lock, so the order
        is always store, then hub; calling the Store with the hub's lock held would deadlock."""
        self.later.append(fn)

    def _run_later(self):
        with self.lock:
            todo, self.later = self.later, []
        for fn in todo:
            fn()
        if todo:
            with self.lock:
                if self.party:  # its views may read what fn changed (Five Lights: the tier)
                    self.party.changed()
                    self._send_party()

    def names(self):
        with self.lock:
            return [p["name"] for p in sorted(self.players.values(), key=lambda p: p["slot"])]

    def _send(self, msg, role=None):
        data = json.dumps(msg)
        for q, r, _ in list(self.subs):
            if role is None or r == role:
                try:
                    q.put_nowait(data)
                except queue.Full:
                    pass

    def _party_msg(self, role, pid):
        view = self.party.wall() if role == "display" else self.party.pad(pid)
        return json.dumps({"type": "party", **view})

    def _send_party(self):
        """The party game's views: one for the wall, and each phone its own."""
        if not self.party:
            return
        self.party_sent = self.party.version
        wall = self._party_msg("display", None)
        for q, role, pid in list(self.subs):
            try:
                q.put_nowait(wall if role == "display" else self._party_msg(role, pid))
            except queue.Full:
                pass

    def roster_changed(self):
        with self.lock:
            self._sync_party()
            self._send(self._roster())
            self._send_party()

    def subscribe(self, role, pid):
        q = queue.Queue(maxsize=300)
        with self.lock:
            self.subs.append([q, role, pid])
            if pid in self.players:
                self.players[pid]["gone"] = None
            q.put_nowait(json.dumps(self._roster()))
            if role == "pad" and self.status:
                q.put_nowait(json.dumps(self.status))
            if self.party:
                q.put_nowait(self._party_msg(role, pid))
        return q

    def unsubscribe(self, q):
        with self.lock:
            entry = next((e for e in self.subs if e[0] is q), None)
            if not entry:
                return
            self.subs.remove(entry)
            pid = entry[2]
            if pid in self.players and not any(e[2] == pid for e in self.subs):
                self.players[pid]["gone"] = time.time()

    def prune(self):
        with self.lock:
            stale = [pid for pid, p in self.players.items() if p["gone"] and time.time() - p["gone"] > 20]
            for pid in stale:
                del self.players[pid]
            if stale:
                self._send(self._roster())
                if self.party:
                    self.party.changed()

    def poll(self):
        """Fetches what the party game is waiting for from the internet (Colours: ESPN's word on
        its match), outside the lock so a slow feed never holds up the game. Called every few
        seconds from its own thread; the game says when it wants a fetch."""
        with self.lock:
            party = self.party
            ask = party.wants(self.clock()) if party and hasattr(party, "wants") else None
        if not ask:
            return
        try:
            got = self.espn(*ask)
        except Exception:
            got = IOError("unavailable")
        with self.lock:
            if self.party is party:
                party.fetched(ask, got)
                if party.version != self.party_sent:
                    self._send_party()

    def tick(self):
        """Runs the party game's clock (called four times a second)."""
        with self.lock:
            if self.party:
                self.party.tick()
                if self.party.version != self.party_sent:
                    self._send_party()

    def join(self, body):
        pid = body.get("pid")
        if not isinstance(pid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{6,40}", pid):
            raise ApiError(400, "Bad player id.")
        name = " ".join(_str(16)(body.get("name") or "").split()).upper()
        with self.lock:
            player = self.players.get(pid)
            if not player:
                used = {p["slot"] for p in self.players.values()}
                slot = next((i for i in range(8) if i not in used), None)
                if slot is None:
                    raise ApiError(409, "This game is full: eight players already.")
                player = {"slot": slot, "color": self.COLORS[slot], "gone": None, "drinks": None}
                self.players[pid] = player
            player["name"] = name or f"PLAYER {player['slot'] + 1}"
            player["gone"] = None
            # "Drinking tonight?": True, False or None (not asked, which counts as no)
            if "drinks" in body:
                player["drinks"] = body["drinks"] if isinstance(body["drinks"], bool) else None
            self._send(self._roster())
            if self.party:
                self.party.changed()
                self._send_party()
            return {"slot": player["slot"], "name": player["name"], "color": player["color"], "drinks": player["drinks"]}

    def leave(self, body):
        with self.lock:
            if self.players.pop(body.get("pid"), None):
                self._send(self._roster())
                if self.party:
                    self.party.changed()
                    self._send_party()

    @staticmethod
    def _check_input(kind, body):
        """A phone's input as the games see it (partygames.INPUTS lists the kinds)."""
        msg = {"kind": kind}
        if kind == "move":
            msg["x"] = _num(0, 1)(body.get("x", 0.5))
        elif kind == "dir":
            msg["dir"] = _choice("up", "down", "left", "right")(body.get("dir"))
        elif kind == "pick":
            if body.get("id") is not None:
                msg["id"] = _str(40)(body["id"])
            if body.get("choice") is not None:
                msg["choice"] = _num(0, 63, True)(body["choice"])
            if len(msg) == 1:
                raise ValueError
        elif kind in ("number", "lock"):
            if kind == "number" or body.get("value") is not None:
                msg["value"] = _num(-1e12, 1e12)(body.get("value"))
        elif kind == "yesno":
            msg["yes"] = _bool(body.get("yes"))
        elif kind == "toggle":
            msg["id"] = _str(40)(body.get("id"))
            msg["on"] = _bool(body.get("on"))
        elif kind == "pour":
            msg["to"] = _num(0, 7, True)(body.get("to"))
        elif kind == "suggest":
            msg["text"] = _str(80)(body.get("text"))
        elif kind == "tap":
            if body.get("n") is not None:  # taps a pad counted up since its last send
                msg["n"] = _num(1, 40, True)(body["n"])
        elif kind == "call":
            msg["home"] = _num(0, 20, True)(body.get("home"))
            msg["away"] = _num(0, 20, True)(body.get("away"))
            msg["lock"] = _bool(body.get("lock", False))
        elif kind == "goal":
            msg["side"] = _choice("home", "away")(body.get("side"))
        elif kind not in partygames.INPUTS:
            raise ValueError
        return msg

    def input(self, body):
        try:
            self._input(body)
        finally:
            self._run_later()

    def _input(self, body):
        with self.lock:
            pid = body.get("pid")
            player = self.players.get(pid)
            if not player:
                raise ApiError(403, "Join the game first.")
            try:
                msg = self._check_input(body.get("kind"), body)
            except ValueError:
                raise ApiError(400, "Unknown input.")
            if self.party:
                self.party.input(pid, msg)
                if self.party.version != self.party_sent:
                    self._send_party()
                return
            self._send({"type": "input", "slot": player["slot"], **msg}, role="display")

    def host_info(self):
        """The party game's view for the control page (guests' prompts to approve...). Called from
        Store.snapshot under the store's lock, so it takes no lock of its own: a game only ever
        hands out copies here."""
        party = self.party
        return party.host() if party else None

    def host(self, body):
        """The host's controls for the party game, from the control page."""
        try:
            self._host(body)
        finally:
            self._run_later()

    def _host(self, body):
        with self.lock:
            if not self.party:
                raise ApiError(409, "No party game is running.")
            try:
                refused = self.party.host_action(body if isinstance(body, dict) else {})
            except ValueError:
                raise ApiError(400, "Unknown action.")
            if refused:
                raise ApiError(409, refused)
            if self.party.version != self.party_sent:
                self._send_party()

    def report(self, body):
        # The wall on the Pi is the referee; previews on phones only count when it isn't running.
        source = body.get("source")
        if source == "kiosk":
            self.kiosk_at = time.time()
        elif time.time() - self.kiosk_at < 5:
            return
        status = {"type": "status", **{k: body[k] for k in ("game", "phase", "message", "players", "seats") if k in body}}
        if len(json.dumps(status)) > 8000:
            raise ApiError(413, "Status too large.")
        with self.lock:
            self.status = status
            self._send(status, role="pad")


# ---------------------------------------------------------------- basement live

class LiveHub:
    """Guests broadcast their phone cameras to the wall (static/live.html). The Pi only passes the
    WebRTC handshake along; the video then goes straight from each phone to the display. Each side
    sends one complete description (no trickled ICE), so the handshake is a phone's offer, pushed
    to the display over its event stream, and the display's answer, which the phone collects by
    long-polling (that also works through the tunnel, where streams can be held back). A phone that
    stops polling (closed, asleep, out of range) is dropped after GONE_AFTER seconds. Nothing is
    saved to disk."""
    MAX = 4
    GONE_AFTER = 30
    POLL_WAIT = 20

    def __init__(self, store):
        self.store = store
        self.cond = threading.Condition()
        self.cams = {}      # cid -> {"name", "slot", "gen", "offer", "answered", "msgs", "seen", "polling"}
        self.seq = 0        # numbers every message to a phone, so a poll can ask for "anything after N"
        self.displays = []  # display event queues, newest last; only the newest one receives cameras

    # -- the wall's side

    def _to_display(self, msg):
        if self.displays:
            try:
                self.displays[-1].put_nowait(json.dumps(msg))
            except queue.Full:
                pass

    def _to_phone(self, cam, msg):
        self.seq += 1
        cam["msgs"] = [m for m in cam["msgs"] if m[0] > self.seq - 20] + [(self.seq, msg)]

    def _greet(self, q):
        """Brings a newly connected display up to date: offers still waiting for an answer go to it
        directly, and phones already streaming to an earlier display are asked for a fresh offer."""
        q.put_nowait(json.dumps({"type": "hello", "cams": [
            {"cid": cid, "name": c["name"], "slot": c["slot"]} for cid, c in self.cams.items()]}))
        for cid, c in self.cams.items():
            if c["offer"] and not c["answered"]:
                q.put_nowait(json.dumps({"type": "offer", "cid": cid, "name": c["name"], "slot": c["slot"],
                                         "gen": c["gen"], "sdp": c["offer"]}))
            else:
                self._to_phone(c, {"type": "reoffer"})

    def subscribe(self):
        q = queue.Queue(maxsize=100)
        with self.cond:
            if self.displays:  # an older display stays connected but hands the cameras over
                try:
                    self.displays[-1].put_nowait(json.dumps({"type": "standby"}))
                except queue.Full:
                    pass
            self.displays.append(q)
            self._greet(q)
            self.cond.notify_all()
        return q

    def unsubscribe(self, q):
        with self.cond:
            was_newest = bool(self.displays) and self.displays[-1] is q
            if q in self.displays:
                self.displays.remove(q)
            if was_newest and self.displays:
                self._greet(self.displays[-1])
            self.cond.notify_all()

    def answer(self, body):
        with self.cond:
            cam = self.cams.get(body.get("cid"))
            sdp = body.get("sdp")
            if not cam or body.get("gen") != cam["gen"] or cam["answered"]:
                raise ApiError(409, "That offer is out of date.")
            if not isinstance(sdp, str) or len(sdp) > 20000:
                raise ApiError(400, "Bad answer.")
            cam["answered"] = True
            self._to_phone(cam, {"type": "answer", "gen": cam["gen"], "sdp": sdp})
            self.cond.notify_all()

    def reoffer(self, body):
        """The display lost a camera's connection and asks that phone to start over."""
        with self.cond:
            cam = self.cams.get(body.get("cid"))
            if cam:
                self._to_phone(cam, {"type": "reoffer"})
                self.cond.notify_all()

    # -- the phone's side

    def _status(self):
        """What a phone shows besides its own connection. "key" lets a poll say which one it saw."""
        screens = self.store.state["screens"]
        on_wall = any(s["enabled"] and s.get("channel") == "live" and not s.get("pinned") for s in screens)
        status = {"display": bool(self.displays), "onWall": on_wall, "count": len(self.cams),
                  "bar": self.store.state["settings"].get("barName") or "THE BASEMENT"}
        status["key"] = json.dumps(status, sort_keys=True)
        return status

    @staticmethod
    def _cid(body):
        cid = body.get("cid")
        if not isinstance(cid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,40}", cid):
            raise ApiError(400, "Bad camera id.")
        return cid

    def offer(self, body):
        cid = self._cid(body)
        sdp = body.get("sdp")
        if not isinstance(sdp, str) or not sdp.startswith("v=") or len(sdp) > 20000:
            raise ApiError(400, "Bad offer.")
        name = " ".join(_str(16)(body.get("name") or "").split()).upper() or "GUEST"
        with self.cond:
            cam = self.cams.get(cid)
            joined = cam is None
            if joined:
                if len(self.cams) >= self.MAX:
                    raise ApiError(409, "The wall is full: four phones are live already. Try again when someone ends.")
                used = {c["slot"] for c in self.cams.values()}
                cam = {"slot": next(i for i in range(self.MAX) if i not in used), "gen": 0, "msgs": [], "polling": 0}
                self.cams[cid] = cam
            cam.update(name=name, gen=cam["gen"] + 1, offer=sdp, answered=False, seen=time.time())
            cam["msgs"] = [m for m in cam["msgs"] if m[1].get("type") != "answer"]
            self._to_display({"type": "offer", "cid": cid, "name": name, "slot": cam["slot"], "gen": cam["gen"], "sdp": sdp})
            gen = cam["gen"]
            self.cond.notify_all()
        if joined:
            self.store.refresh()
        return {"gen": gen, "seq": self.seq, "status": self._status()}

    def poll(self, cid, since, seen_status):
        """Waits up to POLL_WAIT seconds for messages after `since`, or a change of status."""
        with self.cond:
            cam = self.cams.get(cid)
            if not cam:
                return {"gone": True, "status": self._status()}
            cam["polling"] += 1
            cam["seen"] = time.time()
            try:
                self.cond.wait_for(lambda: cid not in self.cams or any(m[0] > since for m in cam["msgs"])
                                   or self._status()["key"] != seen_status, timeout=self.POLL_WAIT)
            finally:
                cam["polling"] -= 1
                cam["seen"] = time.time()
            if cid not in self.cams:
                return {"gone": True, "status": self._status()}
            return {"msgs": [m[1] for m in cam["msgs"] if m[0] > since], "seq": self.seq, "status": self._status()}

    def leave(self, body):
        with self.cond:
            gone = self.cams.pop(body.get("cid"), None)
            if gone:
                self._to_display({"type": "leave", "cid": body.get("cid")})
                self.cond.notify_all()
        if gone:
            self.store.refresh()

    def prune(self):
        with self.cond:
            now = time.time()
            stale = [cid for cid, c in self.cams.items() if not c["polling"] and now - c["seen"] > self.GONE_AFTER]
            for cid in stale:
                del self.cams[cid]
                self._to_display({"type": "leave", "cid": cid})
            if stale:
                self.cond.notify_all()
        if stale:
            self.store.refresh()

    def wake(self):
        """Something phones show may have changed (the wall's channel): answer their polls now."""
        with self.cond:
            self.cond.notify_all()

    def names(self):
        with self.cond:
            return [c["name"] for c in sorted(self.cams.values(), key=lambda c: c["slot"])]


def parse_tunnel_host(text):
    """The last quick-tunnel address in some cloudflared output, or "". cloudflared prints it in a
    box when the tunnel is up ("|  https://some-random-words.trycloudflare.com  |"); its own API
    host (api.trycloudflare.com) shows up in error messages and isn't one."""
    found = ""
    for m in re.finditer(r"https://([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.trycloudflare\.com(?![a-z0-9-]|\.[a-z0-9])", text or "", re.I):
        if m.group(1).lower() != "api":
            found = m.group(1).lower() + ".trycloudflare.com"
    return found


def parse_quicktunnel(body):
    """The address from cloudflared's metrics endpoint: GET /quicktunnel -> {"hostname": "..."}."""
    try:
        host = json.loads(body).get("hostname") or ""
    except (ValueError, AttributeError):
        return ""
    if not isinstance(host, str) or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com", host, re.I):
        return ""
    return parse_tunnel_host("https://" + host)


class Tunnel:
    """Keeps track of the quick tunnel's current address. First choice is cloudflared's metrics
    endpoint (the unit runs it with --metrics TUNNEL_METRICS), which answers with the address the
    running tunnel actually has. If that can't be reached (an older cloudflared, a port clash), the
    address is read from the service's log, from the current run only (its systemd invocation id),
    so an address from before a restart is never shown."""

    def __init__(self, store, metrics=TUNNEL_METRICS):
        self.store = store
        self.metrics = metrics
        self.host = ""

    def _from_metrics(self):
        if not self.metrics:
            return ""
        try:
            with urllib.request.urlopen(f"http://{self.metrics}/quicktunnel", timeout=2) as res:
                return parse_quicktunnel(res.read(4096))
        except Exception:
            return ""

    def _from_journal(self):
        if not (shutil.which("systemctl") and shutil.which("journalctl")):
            return ""
        try:
            run = subprocess.run(["systemctl", "show", "-p", "InvocationID", "--value", TUNNEL_UNIT],
                                 capture_output=True, text=True, timeout=5)
            invocation = run.stdout.strip()
            if not re.fullmatch(r"[0-9a-f]{32}", invocation):
                return ""  # not running
            log = subprocess.run(["journalctl", "--no-pager", "-o", "cat", f"_SYSTEMD_INVOCATION_ID={invocation}"],
                                 capture_output=True, text=True, timeout=10)
            return parse_tunnel_host(log.stdout)
        except (OSError, subprocess.SubprocessError):
            return ""

    def check(self):
        host = self._from_metrics() or self._from_journal()
        if host != self.host:
            self.host = host
            self.store.refresh()
        return host

    def run(self):
        while True:
            self.check()
            time.sleep(60 if self.host else 10)

    @property
    def url(self):
        return f"https://{self.host}/live" if self.host else ""


def parse_throttled(text):
    """The firmware's power and heat flags from `vcgencmd get_throttled` ("throttled=0x50005"), or None."""
    m = re.search(r"throttled=0x([0-9a-f]+)", text or "", re.I)
    return int(m.group(1), 16) if m else None


def health_report(temp, flags):
    """What the remote says about the Pi. heat: ok, warm (from 70 °C) or hot (80 °C, where it slows itself
    down). power: ok, dipped (short of power at some point since it started) or low (short of it now).
    None when neither can be read (not a Pi)."""
    if temp is None and flags is None:
        return None
    heat = None if temp is None else "hot" if temp >= HOT_C else "warm" if temp >= WARM_C else "ok"
    power = None if flags is None else "low" if flags & 0x1 else "dipped" if flags & 0x10000 else "ok"
    return {"temp": None if temp is None else round(temp), "heat": heat, "power": power}


class Health:
    """Keeps an eye on the Pi itself, which runs bare, with no case or fan: its temperature and its
    power, read every 30 seconds. The remote shows both under Settings and warns on every tab when
    the Pi is too hot or short of power."""

    def __init__(self, store, thermal=THERMAL_ZONE, vcgencmd=VCGENCMD):
        self.store = store
        self.thermal = thermal
        self.vcgencmd = vcgencmd
        self.report = None

    def _temp(self):
        try:
            with open(self.thermal, encoding="ascii") as f:
                return int(f.read().strip()) / 1000
        except (OSError, ValueError):
            return None

    def _flags(self):
        if not self.vcgencmd:
            return None
        try:
            run = subprocess.run([self.vcgencmd, "get_throttled"], capture_output=True, text=True, timeout=5)
            return parse_throttled(run.stdout)
        except (OSError, subprocess.SubprocessError):
            return None

    def check(self):
        report = health_report(self._temp(), self._flags())
        if report != self.report:
            self.report = report
            self.store.refresh()
        return report

    def run(self):
        while True:
            self.check()
            time.sleep(30)

    def info(self):
        return self.report


_qr_cache = {}


def qr_matrix(text):
    """The QR code for `text` as rows of "1" (dark) and "0", made by the qrencode tool, or None.
    qrencode's ASCII output draws each dark module as "##", one line per row."""
    if not QRENCODE or not text:
        return None
    if text in _qr_cache:
        return _qr_cache[text]
    try:
        run = subprocess.run([QRENCODE, "-t", "ASCII", "-m", "0", "-l", "M", "-o", "-", text],
                             capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    rows = ["".join("1" if line[i] == "#" else "0" for i in range(0, len(line), 2))
            for line in run.stdout.split("\n") if line]
    if run.returncode != 0 or len(rows) < 21 or any(len(r) != len(rows) for r in rows):
        return None
    if len(_qr_cache) > 20:
        _qr_cache.clear()
    _qr_cache[text] = rows
    return rows


def join_link(join_url):
    """The games' join address as a phone camera opens it: the hub keeps it without a scheme."""
    if not join_url:
        return ""
    return join_url if re.match(r"https?://", join_url) else "http://" + join_url


def qr_svg(rows, margin=4):
    n = len(rows) + margin * 2
    path = "".join(f"M{x + margin} {y + margin}h1v1h-1z" for y, row in enumerate(rows) for x, v in enumerate(row) if v == "1")
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {n} {n}" shape-rendering="crispEdges">'
            f'<rect width="{n}" height="{n}" fill="#fff"/><path d="{path}" fill="#000"/></svg>')


# ---------------------------------------------------------------- now showing

def film_title(title):
    """The film's name without Wikipedia's disambiguation: "Heat (1995 film)" -> "Heat"."""
    return re.sub(r"\s*\([^()]*\b(?:film|movie)\)$", "", title or "").strip()


def film_year(text):
    m = re.search(r"\b(1[89]\d\d|20\d\d)\b", text or "")
    return int(m.group(1)) if m else None


def film_director(desc):
    """Wikipedia's short descriptions read "1974 film by Francis Ford Coppola" for most films."""
    m = re.search(r"\bfilm (?:directed )?by (.+)$", desc or "")
    name = m.group(1).strip() if m else ""
    return name if 0 < len(name) <= 40 and " and " not in name and "," not in name else ""


def parse_film_pages(data):
    """Films from a Wikipedia query (a search, or pages by id), in the search's order. A film
    series, a TV miniseries and the like have the film infobox too, but aren't one film."""
    pages = (data.get("query") or {}).get("pages") or []
    if isinstance(pages, dict):
        pages = list(pages.values())
    films = []
    for p in sorted(pages, key=lambda p: p.get("index", 0)):
        if not isinstance(p, dict) or p.get("missing") or "pageid" not in p:
            continue
        desc = p.get("description") or ""
        if re.search(r"\b(?:series|miniseries|franchise|trilogy|soundtrack|novel|television)\b", desc, re.I):
            continue
        thumb = p.get("thumbnail") or {}
        films.append({
            "key": str(p["pageid"]),
            "title": film_title(p.get("title")),
            "year": film_year(desc),
            "desc": desc[:120],
            "director": film_director(desc),
            "qid": (p.get("pageprops") or {}).get("wikibase_item") or "",
            "thumb": thumb.get("source") or "",
            "tw": thumb.get("width") or 0,
            "th": thumb.get("height") or 0,
        })
    return films


def wiki_films(params):
    query = {"action": "query", "format": "json", "formatversion": 2,
             "prop": "pageimages|pageprops|description", "piprop": "thumbnail", "pithumbsize": 500,
             "pilicense": "any", "ppprop": "wikibase_item", **params}
    return parse_film_pages(json.loads(fetch_url("https://en.wikipedia.org/w/api.php?" + urlencode(query), ua=WIKI_UA)))


def search_films(text):
    return wiki_films({"generator": "search", "gsrsearch": f'{text} hastemplate:"Infobox film"',
                       "gsrnamespace": 0, "gsrlimit": 8})


def parse_film_claims(data):
    """Year (the earliest release date) and running time in minutes from Wikidata's claims. A film
    can list several running times (cuts, countries); the preferred one, else the first, wins."""
    claims = data.get("claims") or {}
    years, runtime = [], None
    for c in claims.get("P577", []):
        t = (((c.get("mainsnak") or {}).get("datavalue") or {}).get("value") or {}).get("time", "")
        if re.match(r"^\+\d{4}-", t):
            years.append(int(t[1:5]))
    runs = sorted(claims.get("P2047", []), key=lambda c: c.get("rank") != "preferred")
    for c in runs:
        v = ((c.get("mainsnak") or {}).get("datavalue") or {}).get("value") or {}
        unit = v.get("unit", "")
        try:
            amount = float(v.get("amount"))
        except (TypeError, ValueError):
            continue
        if unit.endswith("/Q7727"):     # minutes
            runtime = amount
        elif unit.endswith("/Q11574"):  # seconds
            runtime = amount / 60
        elif unit.endswith("/Q25235"):  # hours
            runtime = amount * 60
        if runtime:
            break
    return {"year": min(years) if years else None,
            "runtime": int(round(runtime)) if runtime and 20 <= runtime <= 600 else None}


def film_claims(qid):
    out = {"year": None, "runtime": None}
    for prop in ("P577", "P2047"):
        data = json.loads(fetch_url("https://www.wikidata.org/w/api.php?" + urlencode(
            {"action": "wbgetclaims", "format": "json", "entity": qid, "property": prop}), ua=WIKI_UA))
        found = parse_film_claims(data)
        out.update({k: v for k, v in found.items() if v})
    return out


def image_ext(data):
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    return None


def film_match(text, title):
    words = re.findall(r"[a-z0-9]+", (text or "").lower())
    have = " ".join(re.findall(r"[a-z0-9]+", (title or "").lower()))
    return bool(words) and all(w in have for w in words)


class Cinema:
    """Now Showing: a movie night on the wall. Tonight's film, its poster and its details come from
    Wikipedia and Wikidata once, then live in data/films/, so a rewatch works with no internet.
    Where the night is (the poster, the two-minute countdown, the film, an intermission, THE END)
    is kept in the saved state with wall-clock times; the wall and the phones work out the
    countdowns from those. Anyone on the Wi-Fi can call an intermission."""

    def __init__(self, store):
        self.store = store
        self.dir = os.path.join(store.data_dir, "films")
        os.makedirs(self.dir, exist_ok=True)
        self.path = os.path.join(self.dir, "films.json")
        try:
            with open(self.path, encoding="utf-8") as f:
                films = json.load(f)
            self.films = {k: v for k, v in films.items() if FILM_KEY.fullmatch(k) and isinstance(v, dict)}
        except (OSError, ValueError, AttributeError):
            self.films = {}
        self.searches = {}  # recent searches, so typing doesn't ask Wikipedia the same thing twice
        store.cinema_info = self.info

    def _save_films(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.films, f, indent=1)
        os.replace(tmp, self.path)

    @staticmethod
    def _public(film):
        return {"key": film["key"], "title": film["title"], "year": film.get("year"), "runtime": film.get("runtime"),
                "director": film.get("director", ""), "poster": f"/films/{film['poster']}" if film.get("poster") else ""}

    def info(self):
        c = self.store.state["cinema"]
        film = self.films.get(c["film"] or "")
        recent = sorted(self.films.values(), key=lambda f: -f.get("watched", 0))[:6]
        return {**c, "film": self._public(film) if film else None, "now": time.time(),
                "recent": [self._public(f) for f in recent]}

    # -- finding the film

    def search(self, text):
        text = " ".join(_str(80)(text or "").split())
        if len(text) < 2:
            return {"results": []}
        with self.store.lock:
            mine = [dict(self._public(f), desc=f.get("desc", ""), cached=True)
                    for f in self.films.values() if film_match(text, f["title"])]
        try:
            found = self.searches.get(text.lower())
            if found is None:
                found = search_films(text)
                if len(self.searches) > 50:
                    self.searches.clear()
                self.searches[text.lower()] = found
        except Exception as e:
            if not mine and getattr(e, "code", None) == 429:
                raise ApiError(503, "Wikipedia asked for a moment's pause. Try again in a few seconds.")
            if not mine:
                raise ApiError(502, "Couldn't reach Wikipedia. Films you've shown before still work offline.")
            return {"results": mine[:5], "offline": True}
        results = []
        for f in found:
            if f["key"] in self.films:
                results.append(dict(self._public(self.films[f["key"]]), desc=f["desc"], cached=True))
            else:
                results.append({"key": f["key"], "title": f["title"], "year": f["year"], "desc": f["desc"],
                                "director": f["director"], "poster": f["thumb"], "cached": False})
        return {"results": results[:5]}

    def _look_up(self, key):
        """Everything the wall needs about one film, fetched once. A landscape picture is usually a
        still from the film rather than its poster, so it's left out (the wall's typographic card
        is the fallback)."""
        try:
            films = wiki_films({"pageids": key})
        except Exception as e:
            if getattr(e, "code", None) == 429:
                raise ApiError(503, "Wikipedia asked for a moment's pause. Try again in a few seconds.")
            raise ApiError(502, "Couldn't reach Wikipedia to look that film up.")
        if not films:
            raise ApiError(404, "That film couldn't be found on Wikipedia.")
        f = films[0]
        film = {"key": key, "title": f["title"], "year": f["year"], "runtime": None, "desc": f["desc"],
                "director": f["director"], "qid": f["qid"], "poster": None}
        if re.fullmatch(r"Q\d+", f["qid"]):
            try:
                found = film_claims(f["qid"])
                film["year"] = found["year"] or film["year"]
                film["runtime"] = found["runtime"]
            except Exception:
                pass
        if f["thumb"].startswith("https://upload.wikimedia.org/") and f["th"] >= f["tw"] * 1.2:
            try:
                data = fetch_url(f["thumb"], timeout=15, ua=WIKI_UA)
                ext = image_ext(data)
                if ext:
                    name = key + ext
                    with open(os.path.join(self.dir, name + ".part"), "wb") as out:
                        out.write(data)
                    os.replace(os.path.join(self.dir, name + ".part"), os.path.join(self.dir, name))
                    film["poster"] = name
            except Exception:
                pass
        return film

    def choose(self, body):
        key = body.get("key")
        if not isinstance(key, str) or not FILM_KEY.fullmatch(key):
            raise ApiError(400, "Bad film.")
        with self.store.lock:
            if self.store.state["cinema"]["phase"] in ("countdown", "film", "intermission"):
                raise ApiError(409, "A film is running. Press The End first.")
            film = self.films.get(key)
        if not film or (film.get("poster") and not os.path.exists(os.path.join(self.dir, film["poster"]))):
            film = self._look_up(key)
        with self.store.lock:
            film["watched"] = time.time()
            self.films[key] = film
            self._save_films()
            self.store.state["cinema"] = {"film": key, "phase": "poster", "at": time.time(), "until": 0.0, "mins": 0}
            self._tune()
            self.store._changed()
            return self._public(film)

    # -- the night

    def _tune(self):
        """Movie night is the whole room: every wall in use goes to Now Showing."""
        for screen in self.store.state["screens"]:
            if screen["enabled"]:
                screen.update(channel="nowshowing", pinned=None)

    def _set(self, phase, until=0.0, mins=0, tune=True):
        c = self.store.state["cinema"]
        c.update(phase=phase, at=time.time(), until=until, mins=mins)
        if tune:
            self._tune()
        self.store._changed()

    def start(self, body=None):
        with self.store.lock:
            c = self.store.state["cinema"]
            if not c["film"]:
                raise ApiError(409, "Choose tonight's film first.")
            if c["phase"] in ("countdown", "film", "intermission"):
                raise ApiError(409, "The film has already started.")
            self._set("countdown", time.time() + COUNTDOWN)

    def intermission(self, body):
        mins = body.get("mins")
        if mins not in INTERMISSIONS or isinstance(mins, bool):
            raise ApiError(400, "Intermissions are 5, 10 or 15 minutes.")
        with self.store.lock:
            if self.store.state["cinema"]["phase"] not in ("film", "intermission"):
                raise ApiError(409, "There's no film running.")
            self._set("intermission", time.time() + mins * 60, mins)

    def resume(self, body=None):
        with self.store.lock:
            if self.store.state["cinema"]["phase"] not in ("countdown", "intermission"):
                raise ApiError(409, "The film is already running.")
            self._set("film")

    def end(self, body=None):
        with self.store.lock:
            c = self.store.state["cinema"]
            if not c["film"] or c["phase"] in ("idle", "end"):
                raise ApiError(409, "There's no film running.")
            self._set("end", time.time() + END_HOLD)

    def tick(self, now=None):
        """Moves the night on: the countdown into the film, an intermission back into it, and
        THE END back to The Bar."""
        now = time.time() if now is None else now
        with self.store.lock:
            c = self.store.state["cinema"]
            if c["phase"] == "countdown" and now >= c["until"] + DIM_DOWN:
                c.update(phase="film", at=c["until"] + DIM_DOWN, until=0.0)
            elif c["phase"] == "intermission" and now >= c["until"]:
                c.update(phase="film", at=c["until"], until=0.0, mins=0)
            elif c["phase"] == "end" and now >= c["until"]:
                c.update(phase="poster", at=now, until=0.0)
                for screen in self.store.state["screens"]:
                    if screen.get("channel") == "nowshowing":
                        screen["channel"] = "rotation"
            else:
                return False
            self.store._changed()
            return True


# ---------------------------------------------------------------- the house pour

def load_drinks(path):
    """The seeded drinks (static/content/drinks.json). Anything malformed is left out rather than
    stopping the server; a missing file just means an empty list."""
    try:
        with open(path, encoding="utf-8") as f:
            items = json.load(f)
    except (OSError, ValueError):
        return []
    drinks = []
    for d in items if isinstance(items, list) else []:
        try:
            if not re.fullmatch(r"d\d{3}", str(d.get("id"))) or any(x["id"] == d["id"] for x in drinks):
                continue
            drinks.append({
                "id": d["id"],
                "name": _str(24)(d["name"]).strip().upper(),
                "glass": _choice(*GLASSES)(d["glass"]),
                "colour": _hex(d["colour"]),
                "colour2": _hex(d["colour2"]) if d.get("colour2") else None,
                "bubbles": bool(d.get("bubbles")), "ice": bool(d.get("ice")),
                "garnish": d.get("garnish") if d.get("garnish") in GARNISHES else "none",
                "alcohol": bool(d.get("alcohol", True)),
            })
        except (AttributeError, KeyError, TypeError, ValueError):
            continue
    return drinks


class HousePour:
    """The House Pour (channel 10): tonight's drinks as a hotel-bar card, and one order at a time on
    the wall, its glass filling for the guest it's for. The host runs it from the control page.
    Guests can ask for a drink from /play only while he has that switched on, and he says yes to
    each one. The menu is saved; orders and requests are only kept in memory, and nothing is
    counted. Putting an order up takes over walls on a quiet channel and gives them back after."""
    SERVED_HOLD = 10        # seconds a served drink stays up before the wall goes back
    MAKING_MAX = 20 * 60    # an order nobody marked served comes down after this long
    MAX_CUSTOM = 12
    MAX_REQUESTS = 10
    TAKE_OVER = ("rotation", "scores", "news", "weather", "visuals")  # never a game or live cameras

    def __init__(self, store):
        self.store = store
        self.order = None      # {"id", "guest", "drink", "phase", "pid", "at"}
        self.requests = []     # [{"rid", "pid", "name", "drink", "at"}], oldest first
        self.answers = {}      # pid -> {"rid", "drink", "state"}: what that phone last asked for
        self.names = []        # names drinks were made for tonight, newest first
        self.guest_names = list  # people on /play and Basement Live (set up in main)
        if not isinstance(self.conf.get("returns"), dict):
            self.conf["returns"] = {}
        if self.returns:  # restarted while a drink was up: the order is gone, so the walls go back
            self.clear()

    @property
    def conf(self):
        return self.store.state["channels"]["pour"]

    @property
    def returns(self):
        """Screen id -> the channel it was on before an order took over (saved, for a restart)."""
        return self.conf["returns"]

    def _drinks(self):
        return self.store.drinks + [d for d in self.conf["custom"] if isinstance(d, dict)]

    def _drink(self, drink_id, tonight=False):
        found = next((d for d in self._drinks() if d.get("id") == drink_id), None)
        if not found or (tonight and drink_id not in self.conf["tonight"]):
            raise ApiError(404, "That drink isn't on tonight's menu." if tonight else "That drink isn't on the list.")
        return found

    def menu(self):
        by_id = {d.get("id"): d for d in self._drinks()}
        return [by_id[i] for i in self.conf["tonight"] if i in by_id]

    def info(self):
        with self.store.lock:
            order = self.order and {k: self.order[k] for k in ("id", "guest", "drink", "phase")}
            names = []
            for n in self.names + list(self.guest_names()):
                if n and n not in names:
                    names.append(n)
            return {"menu": self.menu(), "order": order, "names": names[:12],
                    "requests": [{"rid": r["rid"], "name": r["name"], "drink": {"id": r["drink"]["id"], "name": r["drink"]["name"]}}
                                 for r in self.requests]}

    # -- the menu

    def update(self, patch):
        if not isinstance(patch, dict):
            raise ApiError(400, "Expected a JSON object.")
        with self.store.lock:
            conf = self.conf
            if "tonight" in patch:
                if not isinstance(patch["tonight"], list):
                    raise ApiError(400, "Bad value for tonight.")
                ids = {d.get("id") for d in self._drinks()}
                conf["tonight"] = [i for i in dict.fromkeys(patch["tonight"]) if isinstance(i, str) and i in ids]
                self.requests = [r for r in self.requests if r["drink"]["id"] in conf["tonight"]]
            if "guestOrders" in patch:
                conf["guestOrders"] = _clean(patch, {"guestOrders": _bool})["guestOrders"]
                if not conf["guestOrders"]:
                    self.requests = []
            self.store._changed()
            return conf

    def add_drink(self, body):
        clean = _clean(body, {"name": _str(24), "glass": _choice(*GLASSES), "colour": _hex})
        name = " ".join(clean.get("name", "").split()).upper()
        if not name or set(clean) != {"name", "glass", "colour"}:
            raise ApiError(400, "A drink needs a name, a glass and a colour.")
        with self.store.lock:
            conf = self.conf
            if len(conf["custom"]) >= self.MAX_CUSTOM:
                raise ApiError(409, f"That's {self.MAX_CUSTOM} of your own drinks already. Remove one first.")
            drink = {"id": "c" + uuid.uuid4().hex[:8], "name": name, "glass": clean["glass"], "colour": clean["colour"],
                     "colour2": None, "bubbles": clean["glass"] == "flute", "ice": clean["glass"] in ("rocks", "highball", "mug"),
                     "garnish": "none", "alcohol": True, "custom": True}
            conf["custom"].append(drink)
            conf["tonight"].append(drink["id"])
            self.store._changed()
            return drink

    def remove_drink(self, drink_id):
        with self.store.lock:
            conf = self.conf
            if not any(d.get("id") == drink_id for d in conf["custom"]):
                raise ApiError(404, "Only your own drinks can be removed.")
            conf["custom"] = [d for d in conf["custom"] if d.get("id") != drink_id]
            conf["tonight"] = [i for i in conf["tonight"] if i != drink_id]
            self.requests = [r for r in self.requests if r["drink"]["id"] != drink_id]
            self.store._changed()

    # -- the order on the wall

    def _answer(self, state):
        if self.order and self.order["pid"] in self.answers and self.answers[self.order["pid"]]["rid"] == self.order["id"]:
            self.answers[self.order["pid"]]["state"] = state

    def _put_up(self, guest, drink, pid=None, rid=None):
        if self.order and self.order["phase"] == "making":
            self._answer("served")
        self.order = {"id": rid or uuid.uuid4().hex[:8], "guest": guest, "drink": drink, "phase": "making",
                      "pid": pid, "at": time.time()}
        if guest:
            self.names = [guest] + [n for n in self.names if n != guest][:11]
        for screen in self.store.state["screens"]:
            if screen["enabled"] and not screen["pinned"] and screen.get("channel") in self.TAKE_OVER:
                self.returns[screen["id"]] = screen["channel"]
                screen["channel"] = "pour"
        self.store._changed()

    def put_up(self, body):
        guest = " ".join(_str(16)(body.get("guest") or "").split()).upper()
        with self.store.lock:
            self._put_up(guest, self._drink(body.get("drink")))
            return self.info()["order"]

    def served(self, body=None):
        with self.store.lock:
            if not self.order:
                raise ApiError(409, "There's no drink on the wall.")
            if self.order["phase"] != "served":
                self.order.update(phase="served", at=time.time())
                self._answer("served")
                self.store._changed(save=False)

    def clear(self, body=None):
        with self.store.lock:
            if self.order:
                self._answer("served")
            self.order = None
            for screen in self.store.state["screens"]:
                prev = self.returns.pop(screen["id"], None)
                if prev in self.TAKE_OVER and screen.get("channel") == "pour":
                    screen["channel"] = prev
            self.returns.clear()
            self.store._changed()

    def tick(self):
        with self.store.lock:
            o = self.order
            if o and time.time() - o["at"] > (self.SERVED_HOLD if o["phase"] == "served" else self.MAKING_MAX):
                self.clear()

    # -- guests asking from their phones

    @staticmethod
    def _pid(body):
        pid = body.get("pid")
        if not isinstance(pid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{6,40}", pid):
            raise ApiError(400, "Bad player id.")
        return pid

    def request(self, body):
        pid = self._pid(body)
        name = " ".join(_str(16)(body.get("name") or "").split()).upper()
        if not name:
            raise ApiError(400, "Type your name first, so the bar knows who it's for.")
        with self.store.lock:
            if not self.conf["guestOrders"]:
                raise ApiError(403, "Asking from your phone is off tonight. Ask at the bar.")
            drink = self._drink(body.get("drink"), tonight=True)
            self.requests = [r for r in self.requests if r["pid"] != pid]
            if len(self.requests) >= self.MAX_REQUESTS:
                raise ApiError(409, "The bar has a few to make already. Try again in a minute.")
            req = {"rid": uuid.uuid4().hex[:8], "pid": pid, "name": name, "drink": drink, "at": time.time()}
            self.requests.append(req)
            self.answers[pid] = {"rid": req["rid"], "drink": drink["name"], "state": "asked"}
            self.store._changed(save=False)
            return self.answers[pid]

    def _take(self, body):
        req = next((r for r in self.requests if r["rid"] == body.get("rid")), None)
        if not req:
            raise ApiError(404, "That request has gone.")
        self.requests.remove(req)
        return req

    def approve(self, body):
        with self.store.lock:
            req = self._take(body)
            self.answers[req["pid"]] = {"rid": req["rid"], "drink": req["drink"]["name"], "state": "making"}
            self._put_up(req["name"], req["drink"], req["pid"], req["rid"])

    def decline(self, body):
        with self.store.lock:
            req = self._take(body)
            self.answers[req["pid"]] = {"rid": req["rid"], "drink": req["drink"]["name"], "state": "passed"}
            self.store._changed(save=False)

    def cancel(self, body):
        """A guest takes their request back."""
        pid = self._pid(body)
        with self.store.lock:
            before = len(self.requests)
            self.requests = [r for r in self.requests if r["pid"] != pid]
            if self.answers.get(pid, {}).get("state") == "asked":
                del self.answers[pid]
            if len(self.requests) != before:
                self.store._changed(save=False)

    def guest(self, pid):
        """What /play shows a guest: whether they can ask, tonight's menu and their last request."""
        with self.store.lock:
            on = bool(self.conf["guestOrders"])
            return {"on": on, "menu": [{"id": d["id"], "name": d["name"], "glass": d["glass"], "alcohol": d.get("alcohol", True)}
                                       for d in self.menu()] if on else [],
                    "mine": self.answers.get(pid) if isinstance(pid, str) else None}


# ---------------------------------------------------------------- HTTP

# Requests that come in through the tunnel carry Cloudflare's headers. From the internet, only the
# camera page and the calls it makes are served; the control page, uploads and settings stay on
# the home Wi-Fi.
TUNNEL_ALLOWED = {("GET", "/live"), ("HEAD", "/live"), ("GET", "/api/live/poll"),
                  ("POST", "/api/live/offer"), ("POST", "/api/live/leave")}


def via_tunnel(headers):
    return bool(headers.get("Cf-Connecting-IP") or headers.get("Cf-Ray"))


def safe_join(base, rel):
    full = os.path.realpath(os.path.join(base, unquote(rel)))
    root = os.path.realpath(base)
    if not full.startswith(root + os.sep) or not os.path.isfile(full):
        return None
    return full


class Handler(BaseHTTPRequestHandler):
    server_version = "BarScreens/1.0"
    protocol_version = "HTTP/1.1"  # keep-alive, so game controllers can send input quickly
    store = None
    feeds = None
    hub = None
    mirror = None
    live = None
    tunnel = None
    cinema = None
    pour = None

    def log_message(self, fmt, *args):
        pass

    # -- responses

    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _file(self, path, cache):
        size = os.path.getsize(path)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",):
            ctype += "; charset=utf-8"
        start, end, status = 0, size - 1, 200
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", "").strip())
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
            else:
                start = max(0, size - int(m.group(2)))
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "public, max-age=31536000, immutable" if cache else "no-cache")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_JSON:
            raise ApiError(413, "Request too large.")
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            raise ApiError(400, "Request body isn't valid JSON.")
        if not isinstance(data, dict):
            raise ApiError(400, "Expected a JSON object.")
        return data

    def _stream(self, q, unsubscribe, first=None):
        """Server-sent events: one message per line from `q`, with a ping every 15 seconds."""
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            if first:
                self.wfile.write(f"data: {first}\n\n".encode())
                self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=15)
                    self.wfile.write(f"data: {msg}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except OSError:
            pass
        finally:
            unsubscribe(q)

    def _mirror_stream(self):
        """The phone's picture as MJPEG, which an <img> on the display plays directly."""
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        last = 0.0
        try:
            while True:
                frame, at = self.mirror.next_frame(last)
                if frame is None or at == last:
                    continue
                last = at
                self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(frame)).encode() + b"\r\n\r\n" + frame + b"\r\n")
                self.wfile.flush()
        except OSError:
            pass

    def _events(self):
        self._stream(self.store.subscribe(), self.store.unsubscribe, self.store.snapshot())

    def _upload(self, qs):
        name = os.path.basename(qs.get("name", ["upload"])[0]) or "upload"
        ext = os.path.splitext(name)[1].lower()
        kind = "image" if ext in IMAGE_EXT else "video" if ext in VIDEO_EXT else None
        if kind is None:
            raise ApiError(415, "Only photos (JPG, PNG, GIF, WebP) and videos (MP4, MOV, WebM) can be added.")
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise ApiError(400, "The file was empty.")
        if length > MAX_UPLOAD:
            raise ApiError(413, "That file is over 2 GB.")
        filename = uuid.uuid4().hex[:12] + ext
        dest = os.path.join(self.store.media_dir, filename)
        remaining = length
        try:
            with open(dest + ".part", "wb") as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ApiError(400, "The upload was cut off. Try again.")
                    f.write(chunk)
                    remaining -= len(chunk)
            os.replace(dest + ".part", dest)
        except BaseException:
            try:
                os.remove(dest + ".part")
            except OSError:
                pass
            raise
        title = os.path.splitext(name)[0].replace("_", " ").strip() or kind.title()
        return self.store.add_media(kind, filename, title, qs.get("addTo", [None])[0])

    # The owner's own lines for the party games, kept as plain text in the data folder:
    # years.txt (Closest Wins' WHAT YEAR? songs and films) and house.txt (Five Lights' prompts).
    LISTS = {"years": ("years.txt", partygames.parse_years), "house": ("house.txt", partygames.parse_house)}

    def _list(self, name, text=None):
        """One of LISTS, read or replaced: {text, count, bad (line numbers)}."""
        filename, parse = self.LISTS[name]
        path = os.path.join(self.store.data_dir, filename)
        if text is not None:
            if not isinstance(text, str) or len(text) > 200_000:
                raise ApiError(400, "Bad list.")
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(text.replace("\r\n", "\n"))
            os.replace(tmp, path)
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except OSError:
            text = ""
        items, bad = parse(text)
        return {"text": text, "count": len(items), "bad": bad}

    # -- routing

    def _route(self):
        url = urlparse(self.path)
        path, qs, method = url.path, parse_qs(url.query), self.command
        store = self.store

        if method in ("GET", "HEAD"):
            if path == "/":
                return self._redirect("/control")
            if path in ("/control", "/display", "/play", "/live", "/film"):
                return self._file(os.path.join(STATIC, path[1:] + ".html"), cache=False)
            if path.startswith("/static/"):
                full = safe_join(STATIC, path[len("/static/"):])
                return self._file(full, cache=False) if full else self._json(404, {"error": "Not found."})
            if path.startswith("/media/"):
                full = safe_join(store.media_dir, path[len("/media/"):])
                return self._file(full, cache=True) if full else self._json(404, {"error": "Not found."})
            if path.startswith("/films/") and not path.endswith(".json"):
                full = safe_join(self.cinema.dir, path[len("/films/"):])
                return self._file(full, cache=False) if full else self._json(404, {"error": "Not found."})
            if path == "/api/cinema/search":
                return self._json(200, self.cinema.search(qs.get("q", [""])[0]))
            if path == "/api/state":
                body = store.snapshot().encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return self.wfile.write(body)
            if path == "/api/events":
                return self._events()
            if path == "/live.mjpg":
                return self._mirror_stream()
            if path == "/api/game/stream":
                role = "pad" if qs.get("role", [""])[0] == "pad" else "display"
                return self._stream(self.hub.subscribe(role, qs.get("pid", [None])[0]), self.hub.unsubscribe)
            m = re.fullmatch(r"/api/feed/(scores|news|weather)", path)
            if m:
                return self._json(200, self.feeds.get(m.group(1)))
            if path == "/api/image":
                try:
                    full = image_file(store.data_dir, qs.get("u", [""])[0])
                except Exception:
                    return self._json(502, {"error": "Couldn't get that picture."})
                return self._file(full, cache=True) if full else self._json(404, {"error": "Not a picture the walls show."})
            m = re.fullmatch(r"/api/game/(years|house)", path)
            if m:
                return self._json(200, self._list(m.group(1)))
            if path == "/api/colours/matches":
                return self._json(200, {"matches": tonight_matches(), "leagues": [[k, v[1]] for k, v in SOCCER.items()]})
            if path == "/api/live/stream":
                return self._stream(self.live.subscribe(), self.live.unsubscribe)
            if path == "/api/live/poll":
                try:
                    since = int(qs.get("since", ["0"])[0])
                except ValueError:
                    since = 0
                return self._json(200, self.live.poll(qs.get("cid", [""])[0], since, qs.get("st", [""])[0]))
            if path == "/api/pour/guest":
                return self._json(200, self.pour.guest(qs.get("pid", [None])[0]))
            if path in ("/api/live/qr", "/api/live/qr.svg"):
                url = self.tunnel.url
                rows = qr_matrix(url)
                if path == "/api/live/qr":
                    return self._json(200, {"url": url, "rows": rows})
                if not rows:
                    return self._json(404, {"error": "No QR code: the secure link isn't ready, or qrencode isn't installed."})
                return self._svg(qr_svg(rows))
            if path == "/api/game/qr.svg":
                # the games' join page (/play on the Wi-Fi), for the control page's Invite sheet
                rows = qr_matrix(join_link(self.hub.join_url))
                if not rows:
                    return self._json(404, {"error": "No QR code: qrencode isn't installed."})
                return self._svg(qr_svg(rows))

        m = re.fullmatch(r"/api/slides/([0-9a-f]+)", path)
        if m and method == "PATCH":
            return self._json(200, store.update_slide(m.group(1), self._read_json()))
        if m and method == "DELETE":
            store.delete_slide(m.group(1))
            return self._json(200, {"ok": True})
        m = re.fullmatch(r"/api/screens/(s[12])(/next)?", path)
        if m and method == "PATCH" and not m.group(2):
            screen = store.update_screen(m.group(1), self._read_json())
            self.hub.roster_changed()
            self.live.wake()
            return self._json(200, screen)
        if m and method == "POST" and m.group(2):
            store.next_slide(m.group(1))
            return self._json(200, {"ok": True})
        if method == "POST" and path == "/api/slides":
            return self._json(201, store.create_slide(self._read_json()))
        if method == "POST" and path == "/api/upload":
            return self._json(201, self._upload(qs))
        if method == "POST" and path == "/api/display":
            store.set_display(self._read_json())
            return self._json(200, {"ok": True})
        if method == "PATCH" and path == "/api/channels":
            conf = store.update_channels(self._read_json())
            self.hub.roster_changed()
            store.refresh()  # the control page's view of the party game that's now picked
            return self._json(200, conf)
        m = re.fullmatch(r"/api/game/(join|leave|input|report|host)", path)
        if m and method == "POST":
            result = getattr(self.hub, m.group(1))(self._read_json())
            return self._json(200, result or {"ok": True})
        m = re.fullmatch(r"/api/game/(years|house)", path)
        if m and method == "POST":
            return self._json(200, self._list(m.group(1), self._read_json().get("text")))
        m = re.fullmatch(r"/api/cinema/(film|start|intermission|resume|end)", path)
        if m and method == "POST":
            name = "choose" if m.group(1) == "film" else m.group(1)
            result = getattr(self.cinema, name)(self._read_json())
            self.hub.roster_changed()
            self.live.wake()
            return self._json(200, result or {"ok": True})
        if method == "POST" and path == "/api/colours/season":
            # Colours: start a new season (the grudge table goes back to nobody)
            partygames.Season(store.data_dir).reset()
            self.hub.roster_changed()
            return self._json(200, {"ok": True})
        m = re.fullmatch(r"/api/live/(offer|answer|reoffer|leave)", path)
        if m and method == "POST":
            result = getattr(self.live, m.group(1))(self._read_json())
            return self._json(200, result or {"ok": True})
        if method == "PATCH" and path == "/api/pour":
            return self._json(200, self.pour.update(self._read_json()))
        if method == "POST" and path == "/api/pour/drinks":
            return self._json(201, self.pour.add_drink(self._read_json()))
        m = re.fullmatch(r"/api/pour/drinks/(c[0-9a-f]{8})", path)
        if m and method == "DELETE":
            self.pour.remove_drink(m.group(1))
            return self._json(200, {"ok": True})
        m = re.fullmatch(r"/api/pour/(order|served|clear|request|approve|decline|cancel)", path)
        if m and method == "POST":
            body = self._read_json()
            result = (self.pour.put_up if m.group(1) == "order" else getattr(self.pour, m.group(1)))(body)
            return self._json(200, result or {"ok": True})
        if method == "PATCH" and path == "/api/settings":
            store.update_settings(self._read_json())
            return self._json(200, {"ok": True})
        return self._json(404, {"error": "Not found."})

    def _svg(self, text):
        body = text.encode()
        self.send_response(200)
        self.send_header("Content-Type", "image/svg+xml")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        return self.wfile.write(body)

    def _refuse(self):
        """403 for anything but the camera page, when the request came in through the tunnel."""
        self.close_connection = True
        if self.path.startswith("/api/"):
            return self._json(403, {"error": "Only the camera page is open through the secure link."})
        body = ('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">'
                '<body style="margin:0;padding:40px 24px;background:#0b0a08;color:#efe6d2;font:20px/1.4 Georgia,serif;text-align:center">'
                'This link only opens <b>Basement Live</b>.<br><br>Scan the code on the wall to go live.</body>').encode()
        self.send_response(403)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _handle(self):
        if self.command == "HEAD":
            self.close_connection = True
        try:
            if via_tunnel(self.headers) and (self.command, urlparse(self.path).path) not in TUNNEL_ALLOWED:
                return self._refuse()
            self._route()
        except ApiError as e:
            self.close_connection = True  # the request body may not have been read
            self._json(e.status, {"error": e.message})
        except (BrokenPipeError, ConnectionResetError):
            pass

    do_GET = do_HEAD = do_POST = do_PATCH = do_DELETE = _handle


def main():
    parser = argparse.ArgumentParser(description="Bar Screens server")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--data", default=os.path.join(ROOT, "data"), help="where uploads and settings are kept")
    parser.add_argument("--tunnel-metrics", default=TUNNEL_METRICS, help="cloudflared's metrics address (host:port)")
    args = parser.parse_args()

    store = Store(args.data)
    Handler.store = store
    Handler.feeds = Feeds(store)
    hub = Handler.hub = GameHub(store)
    mirror = Handler.mirror = Mirror(MIRROR_PORT)
    live = Handler.live = LiveHub(store)
    tunnel = Handler.tunnel = Tunnel(store, args.tunnel_metrics)
    cinema = Handler.cinema = Cinema(store)
    pour = Handler.pour = HousePour(store)
    health = Health(store)
    store.health_info = health.info
    host =f"{socket.gethostname().removesuffix('.local')}.local" + ("" if args.port == 80 else f":{args.port}")
    hub.join_url = f"{host}/play"
    store.party_info = hub.host_info
    store.live_info = lambda: {"url": tunnel.url, "lan": f"http://{host}/live", "qr": bool(QRENCODE), "cams": live.names()}
    store.pour_info = pour.info
    pour.guest_names = lambda: hub.names() + live.names()

    def ticker():
        beats = 0
        while True:
            time.sleep(0.25)
            store.tick()
            hub.tick()
            cinema.tick()
            pour.tick()
            beats += 1
            store.set_mirroring(mirror.live)
            if beats % 4 == 0:
                hub.prune()
                live.prune()

    def poller():
        while True:
            time.sleep(5)
            hub.poll()

    threading.Thread(target=ticker, daemon=True).start()
    threading.Thread(target=poller, daemon=True).start()
    threading.Thread(target=tunnel.run, daemon=True).start()
    threading.Thread(target=health.run, daemon=True).start()
    server =ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print(f"Bar Screens is running. Control it from http://{host}/control (games: http://{host}/play, "
          f"intermissions: http://{host}/film)", flush=True)
    if not FFMPEG:
        print("ffmpeg not found: videos will be played as uploaded, without conversion.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
