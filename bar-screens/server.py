#!/usr/bin/env python3
"""Bar Screens: drive the LED walls from a Raspberry Pi.

The Pi's HDMI output feeds the NovaStar TB6's HDMI IN. Chromium shows /display
full-screen, and any phone on the home Wi-Fi opens /control to change what's on
the walls. Standard library only, so it runs on a fresh Raspberry Pi OS.
"""

import argparse
import datetime
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

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
MAX_UPLOAD = 2 * 1024 ** 3
MAX_JSON = 1024 ** 2
FONTS = ["Anton", "Limelight", "Bebas Neue", "Barlow Condensed", "Silkscreen", "VT323"]
FFMPEG = shutil.which("ffmpeg")

# Channel 1 is your own rotation; the rest are live channels drawn on the Pi from free data feeds.
CHANNELS = ["rotation", "scores", "news", "weather", "visuals"]
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
VISUAL_STYLES = ["mix", "skyline", "deco", "fans", "neon", "bubbles", "lava", "beams", "fire", "plasma", "warp"]

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
SETTINGS_FIELDS = {"brightness": _num(5, 100, True), "blackout": _bool, "testPattern": _bool, "barName": _str(24)}
SCREEN_FIELDS["channel"] = _choice(*CHANNELS)


def default_channels():
    return {
        "scores": {"leagues": ["eng.1", "sco.1"]},
        "news": {"feed": "top"},
        "weather": {"place": "", "label": "", "lat": None, "lon": None},
        "visuals": {"style": "mix"},
    }


def default_screen(sid, name, enabled):
    # Screen 1 starts out covering the whole HDMI picture, so something always reaches the wall.
    return {"id": sid, "name": name, "enabled": enabled, "w": 1920, "h": 1080,
            "x": 0, "y": 0, "rw": 1920, "rh": 1080, "channel": "rotation", "playlist": [], "pinned": None}


def default_state():
    return {
        "settings": {"brightness": 100, "blackout": False, "testPattern": True, "barName": "THE BASEMENT"},
        "screens": [default_screen("s1", "Screen 1", True), default_screen("s2", "Screen 2", False)],
        "slides": [],
        "channels": default_channels(),
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
                "ffmpeg": bool(FFMPEG),
                "catalog": {
                    "leagues": [[k, v[1]] for k, v in LEAGUES.items()],
                    "feeds": [[k, v[1]] for k, v in NEWS_FEEDS.items()],
                    "styles": VISUAL_STYLES,
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
            self._changed()
            return screen

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
            if found is not None:
                conf["weather"] = found
            self._changed()
            return conf

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

def fetch_url(url, timeout=8):
    req = urllib.request.Request(url, headers={"User-Agent": "BarScreens/1.0 (home LED display)"})
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


def _team(competitor):
    t = competitor.get("team") or {}
    color = t.get("color") or ""
    return {
        "abbr": (t.get("abbreviation") or t.get("shortDisplayName") or "?")[:4].upper(),
        "name": t.get("shortDisplayName") or t.get("displayName") or "",
        "score": str(competitor.get("score") or ""),
        "color": "#" + color if re.fullmatch(r"[0-9a-fA-F]{6}", color) else None,
    }


def fetch_scores(conf):
    today = datetime.date.today()
    span = f"{today - datetime.timedelta(days=1):%Y%m%d}-{today + datetime.timedelta(days=6):%Y%m%d}"
    leagues, failures = [], 0
    for key in conf.get("leagues", []):
        if key not in LEAGUES:
            continue
        path, title = LEAGUES[key]
        try:
            data = json.loads(fetch_url(f"https://site.api.espn.com/apis/site/v2/sports/{path}/scoreboard?dates={span}&limit=200"))
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
            })
        leagues.append({"key": key, "name": title, "matches": matches})
    if failures and not leagues:
        raise IOError("scores unavailable")
    return {"leagues": leagues}


def fetch_news(conf):
    url, section = NEWS_FEEDS.get(conf.get("feed"), NEWS_FEEDS["top"])
    root = ET.fromstring(fetch_url(url))
    items = []
    for item in root.iter("item"):
        title = " ".join((item.findtext("title") or "").split())
        if title and title not in (i["title"] for i in items):
            items.append({"title": title})
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
        "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day",
        "hourly": "temperature_2m,weather_code,precipitation_probability",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
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
    return {"place": conf.get("label", ""),
            "now": {"temp": cur["temperature_2m"], "feels": cur.get("apparent_temperature"),
                    "code": cur["weather_code"], "wind": cur.get("wind_speed_10m"), "day": bool(cur.get("is_day", 1))},
            "hours": hours, "days": days}


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


# ---------------------------------------------------------------- HTTP

def safe_join(base, rel):
    full = os.path.realpath(os.path.join(base, unquote(rel)))
    root = os.path.realpath(base)
    if not full.startswith(root + os.sep) or not os.path.isfile(full):
        return None
    return full


class Handler(BaseHTTPRequestHandler):
    server_version = "BarScreens/1.0"
    store = None
    feeds = None

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

    def _events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        q = self.store.subscribe()
        try:
            self.wfile.write(f"data: {self.store.snapshot()}\n\n".encode())
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
            self.store.unsubscribe(q)

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

    # -- routing

    def _route(self):
        url = urlparse(self.path)
        path, qs, method = url.path, parse_qs(url.query), self.command
        store = self.store

        if method in ("GET", "HEAD"):
            if path == "/":
                return self._redirect("/control")
            if path in ("/control", "/display"):
                return self._file(os.path.join(STATIC, path[1:] + ".html"), cache=False)
            if path.startswith("/static/"):
                full = safe_join(STATIC, path[len("/static/"):])
                return self._file(full, cache=False) if full else self._json(404, {"error": "Not found."})
            if path.startswith("/media/"):
                full = safe_join(store.media_dir, path[len("/media/"):])
                return self._file(full, cache=True) if full else self._json(404, {"error": "Not found."})
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
            m = re.fullmatch(r"/api/feed/(scores|news|weather)", path)
            if m:
                return self._json(200, self.feeds.get(m.group(1)))

        m = re.fullmatch(r"/api/slides/([0-9a-f]+)", path)
        if m and method == "PATCH":
            return self._json(200, store.update_slide(m.group(1), self._read_json()))
        if m and method == "DELETE":
            store.delete_slide(m.group(1))
            return self._json(200, {"ok": True})
        m = re.fullmatch(r"/api/screens/(s[12])(/next)?", path)
        if m and method == "PATCH" and not m.group(2):
            return self._json(200, store.update_screen(m.group(1), self._read_json()))
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
            return self._json(200, store.update_channels(self._read_json()))
        if method == "PATCH" and path == "/api/settings":
            store.update_settings(self._read_json())
            return self._json(200, {"ok": True})
        return self._json(404, {"error": "Not found."})

    def _handle(self):
        try:
            self._route()
        except ApiError as e:
            self._json(e.status, {"error": e.message})
        except (BrokenPipeError, ConnectionResetError):
            pass

    do_GET = do_HEAD = do_POST = do_PATCH = do_DELETE = _handle


def main():
    parser = argparse.ArgumentParser(description="Bar Screens server")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--data", default=os.path.join(ROOT, "data"), help="where uploads and settings are kept")
    args = parser.parse_args()

    store = Store(args.data)
    Handler.store = store
    Handler.feeds = Feeds(store)

    def ticker():
        while True:
            time.sleep(0.25)
            store.tick()

    threading.Thread(target=ticker, daemon=True).start()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    port = "" if args.port == 80 else f":{args.port}"
    print(f"Bar Screens is running. Control it from http://{socket.gethostname()}.local{port}/control", flush=True)
    if not FFMPEG:
        print("ffmpeg not found: videos will be played as uploaded, without conversion.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
