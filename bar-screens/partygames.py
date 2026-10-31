"""Party games the Pi referees: the shared game kit, Closest Wins, Five Clues and Five Lights.

The arcade games (static/games.js) run on the wall and only use the Pi to pass controller input
along. Quiz and vote games are different: everyone answers at once, nobody should see anyone
else's answer, the decks mustn't repeat and points have to be fair, so the Pi runs them. A game
here is a small state machine (PartyGame) that GameHub ticks four times a second. Each change
goes out over the game stream as two views: one for the wall (what everyone in the room sees)
and one per phone (only that player's own controls and result). The wall draws its view with
static/party.js and the phones build their pads from theirs in static/play.html.

Writing a new party game (Five Lights, The Verdict, Colours; Five Clues is a second example):

  1. Subclass PartyGame, set `key` and `title`, and add it to PARTY_GAMES (and to GAMES in
     server.py, so it shows in the game pickers).
  2. Move through phases with self.go(phase, seconds, **data). `data` is merged into the wall
     view; on_timeout() is called when the seconds run out (None waits for the players).
  3. Handle phone input in on_input(pid, msg). The kinds are listed in INPUTS; the hub has
     already checked them.
  4. Say what each phone shows in pad(pid) by returning one of the pads play.html knows:
     wait, start, number, pick, buzz, yesno, toggle, result, next (see PADS below).
  5. Draw the wall in static/party.js: register a renderer with BarParty.register(key, ...).
     The shared screens are there already: phase "lobby" (pass lines=[...]), "card" between
     rounds (round, heading, lines, night=self.podium(self.night)) and "podium" (label,
     places=self.podium()), plus lock dots, countdown bars and sip drops.

Shared pieces: load_deck() reads static/content/<deck>.json, UsedItems keeps a deck from
repeating until it runs out (saved in the data folder, so across nights), award_sip() and
offer_pour() handle the drinking rules (below), points/night/podium() keep score.

The drinking rules: sips are off unless the host switches "Sips" on for the night on the control
page. Each phone answers "Drinking tonight?" when it joins (and can change it); only players who
said yes are ever given a sip, and it is always one sip of anything, water included. The wall
never shows who is or isn't drinking: a sip appears there only as a small gold drop by a name.
"""

import datetime
import hashlib
import json
import os
import random
import re
import threading
import time

ROOT = os.path.dirname(os.path.abspath(__file__))
CONTENT = os.path.join(ROOT, "static", "content")

# What a phone can send, checked by GameHub.input before a game sees it. Arcade games get the
# same messages over the bus on the wall.
#   move {x: 0-1}            slider position           dir {dir: up/down/left/right}
#   tap, start, buzz         a press                   next, end   next round / finish (podium)
#   pick {choice: n | id}    one of N options          number {value}   a dial's current value
#   lock {value?}            final answer              yesno {yes: bool}
#   toggle {id, on: bool}    a switch (DOUBLE)         pour {to: slot}  hand someone a sip
INPUTS = ("move", "dir", "tap", "start", "buzz", "next", "end", "pick", "number", "lock", "yesno", "toggle", "pour")

# The pads play.html can show, by a pad view's "ui". Every pad view also has "key" (the pad is
# rebuilt when it changes), and may have "title" (small gold line), "deadline" (server time the
# countdown bar runs to), "notice" ({title, text}: a sip), "pour" ({options: [{slot, name}]}),
# "lights" ({lit, of}: a row of bulbs, Five Lights).
#   wait    {big, text}                         eyes on the wall
#   start   {big, text, label, choices?: [{id, label}], chosen, choicesTitle}   a lobby: Start,
#           and optionally a row of settings above it (each tap sends pick {id})
#   number  {min, max, step, year, unit, value, locked}   the dial, with LOCK
#   pick    {options: [{id, label, color?}], cols, chosen, locked}   2x2 grid or a list of names
#   buzz    {label, value, locked, text}        one big BUZZ
#   yesno   {yes, no, chosen, locked, lead?, prompt?, text?, pair?}   a pair of buttons, under an
#           optional prompt; pair: the second one is an ivory outline (I HAVE / NEVER)
#   toggle  {id, label, on, text}               one switch, e.g. DOUBLE
#   result  {big, text, tone}                   how you did (tone: win / good / plain)
#   next    {big, text, buttons: [{kind, label, quiet?}]}   end of a round (quiet: not gold)
PADS = ("wait", "start", "number", "pick", "buzz", "yesno", "toggle", "result", "next")

DROP_FOR = 15  # seconds a sip's gold drop stays by a name on the wall


# ---------------------------------------------------------------- decks

_decks = {}


def load_deck(name, folder=CONTENT):
    """The items of static/content/<name>.json: a JSON list of objects, each with a unique "id"
    (or an object whose values are such lists, which are joined). Re-read when the file changes;
    a missing or broken deck is an empty one, so a bad edit can't stop the server."""
    if not re.fullmatch(r"[a-z0-9_-]{1,40}", name or ""):
        return []
    path = os.path.join(folder, name + ".json")
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return []
    hit = _decks.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    if isinstance(data, dict):
        data = [i for v in data.values() if isinstance(v, list) for i in v]
    items, seen = [], set()
    for item in data if isinstance(data, list) else []:
        if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"] not in seen:
            seen.add(item["id"])
            items.append(item)
    _decks[path] = (mtime, items)
    return items


class UsedItems:
    """Which items of each deck have been played, saved in the data folder (used.json), so a deck
    doesn't repeat itself until the part being drawn from runs out, even across restarts. A game
    draws from a pool (a whole deck, one category of it, ...); when that pool has too few unplayed
    items left, the pool starts over and the rest of the deck is left as it is."""

    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            self.used = {k: set(v) for k, v in data.items() if isinstance(v, list)}
        except (OSError, ValueError, AttributeError):
            self.used = {}

    def _save(self):
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({k: sorted(v) for k, v in self.used.items()}, f)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def draw(self, deck, pool, n, rand=random):
        """Up to n items from `pool` (dicts with "id"), unplayed ones first, marked as played."""
        with self.lock:
            used = self.used.setdefault(deck, set())
            fresh = [i for i in pool if i["id"] not in used]
            rand.shuffle(fresh)
            picked = fresh[:n]
            if len(picked) < n:  # this pool has run out: it starts over
                used.difference_update(i["id"] for i in pool)
                got = {i["id"] for i in picked}
                rest = [i for i in pool if i["id"] not in got]
                rand.shuffle(rest)
                picked += rest[:n - len(picked)]
            used.update(i["id"] for i in picked)
            self._save()
            return picked

    def played(self, deck):
        with self.lock:
            return set(self.used.get(deck, ()))

    def forget(self, deck):
        with self.lock:
            self.used.pop(deck, None)
            self._save()


# ---------------------------------------------------------------- the owner's own years

YEAR_LINE = re.compile(r"\s+[-–—]\s+")


def parse_years(text, this_year=None):
    """The owner's years.txt: one "artist - title - year" per line (or "title - year"), each
    turned into a WHAT YEAR? question. Blank lines and lines starting with # are skipped.
    Returns (items, bad line numbers). Ids come from the words, so editing the file doesn't
    make old questions look new."""
    this_year = this_year or datetime.date.today().year
    items, bad, seen = [], [], set()
    for n, raw in enumerate((text or "").splitlines(), 1):
        line = " ".join(raw.split())
        if not line or line.startswith("#"):
            continue
        m = re.fullmatch(r"(.+?)\s*\((\d{4})\)", line)  # "artist - title (1999)" works too
        parts = YEAR_LINE.split(m.group(1)) + [m.group(2)] if m else YEAR_LINE.split(line)
        year = parts[-1].strip()
        if len(parts) < 2 or not re.fullmatch(r"\d{4}", year) or not 1900 <= int(year) <= this_year:
            bad.append(n)
            continue
        title = parts[-2].strip().upper()[:40]
        artist = " - ".join(parts[:-2]).strip().upper()[:32]
        if not title:
            bad.append(n)
            continue
        uid = "y-" + hashlib.sha1(f"{artist}|{title}".encode()).hexdigest()[:10]
        if uid in seen:
            continue
        seen.add(uid)
        items.append({"id": uid, "q": title, "by": artist, "unit": "YEAR", "answer": int(year),
                      "min": min(1950, int(year)), "max": this_year, "step": 1, "category": "yours"})
    return items, bad


def fmt(value, year=False):
    """A number as the wall writes it: 1,470 (years without the comma)."""
    value = int(round(value))
    return str(value) if year else f"{value:,}"


def ordinal(n):
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def initials(names):
    """One letter per player, or two where first letters clash (dots on the wall are small)."""
    firsts = [(n or "?")[0] for n in names]
    out = []
    for name, first in zip(names, firsts):
        out.append(first if firsts.count(first) == 1 else (name or "??")[:2])
    return out


def sips_until(now):
    """When a night's "Sips: on" switches itself off: the next 6 am."""
    t = datetime.datetime.fromtimestamp(now)
    end = t.replace(hour=6, minute=0, second=0, microsecond=0)
    if end <= t:
        end += datetime.timedelta(days=1)
    return end.timestamp()


# ---------------------------------------------------------------- the kit

class PartyGame:
    """A game the Pi referees. GameHub creates one when it's picked, calls input() for each phone
    message and tick() four times a second, and sends wall() to the display and pad(pid) to each
    phone whenever `version` changes. Everything runs under the hub's lock.

    Players are the hub's: hub.players maps a phone's pid to {"slot", "name", "color", "drinks",
    "gone"}. Scores are kept by pid, so someone whose phone drops out and comes back keeps theirs.
    """
    key = ""
    title = ""
    IDLE = 600  # seconds a finished round waits for "Next round" before going back to the lobby

    def __init__(self, hub, rand=None):
        self.hub = hub
        self.rand = rand or random.Random()
        self.version = 0
        self.phase, self.at, self.until, self.data = "lobby", self.now(), None, {}
        self.round = 0
        self.points = {}   # pid -> this round's points
        self.night = {}    # pid -> points across tonight's rounds
        self.known = {}    # pid -> {"slot", "name", "color"}: the last we saw, for the podium
        self.drops = {}    # pid -> when their latest sip shows (a gold drop by the name)
        self.notices = {}  # pid -> {"title", "text", "at"}: shown on that phone for a while
        self.pours = {}    # pid -> (from, until): when they may hand one sip to another drinker
        self.wakes = []    # times something changes without input (a reveal reaching its answer)

    # -- time and phases

    def now(self):
        return self.hub.clock()

    def changed(self):
        self.version += 1

    def go(self, phase, secs=None, **data):
        """Move to `phase` for `secs` seconds (None: until the game moves on itself)."""
        self.phase, self.at = phase, self.now()
        self.until = self.at + secs if secs is not None else None
        self.data = data
        self.changed()

    def wake(self, at):
        self.wakes.append(at)

    def tick(self):
        now = self.now()
        due = [w for w in self.wakes if w <= now]
        if due:
            self.wakes = [w for w in self.wakes if w > now]
            self.changed()
        for pid, (_, until) in list(self.pours.items()):
            if until <= now:
                del self.pours[pid]
                self.changed()
        if self.until is not None and now >= self.until:
            self.until = None
            self.on_timeout()
        elif self.phase == "podium" and now - self.at > self.IDLE:
            self.go("lobby")

    # -- players

    def players(self):
        """Who's here now, by slot: [(pid, player)]. Also remembers names for the podium."""
        here = sorted(((pid, p) for pid, p in self.hub.players.items() if not p.get("gone")), key=lambda e: e[1]["slot"])
        for pid, p in here:
            self.known[pid] = {"slot": p["slot"], "name": p["name"], "color": p["color"]}
        return here

    def who(self, pid):
        p = self.hub.players.get(pid)
        if p:
            self.known[pid] = {"slot": p["slot"], "name": p["name"], "color": p["color"]}
        return self.known.get(pid, {"slot": -1, "name": "?", "color": "#b89a63"})

    # -- sips

    def drinking(self, pid):
        p = self.hub.players.get(pid)
        return bool(self.hub.sips_on() and p and p.get("drinks") is True)

    def award_sip(self, pid, text, at=None, title="A SIP"):
        """Gives one sip to `pid` if sips are on tonight and they said they're drinking; nobody
        else is ever given one. It shows from `at` (default now) as a gold drop by their name on
        the wall and a note on their phone. Returns whether a sip was given."""
        if not self.drinking(pid):
            return False
        at = self.now() if at is None else at
        self.drops[pid] = at
        self.notices[pid] = {"title": title, "text": text, "at": at}
        if at > self.now():
            self.wake(at)
        self.changed()
        return True

    def offer_pour(self, pid, secs=60, at=None):
        """Lets `pid` hand one sip to another drinker from their phone (a reward). Only offered
        when sips are on, they're drinking themselves and someone else is."""
        if self.drinking(pid) and self.pour_options(pid):
            at = self.now() if at is None else at
            self.pours[pid] = (at, at + secs)
            self.notices[pid] = {"title": "POUR ONE OUT", "text": "Hand one sip to someone. Any drink or water counts.", "at": at}
            if at > self.now():
                self.wake(at)
            self.changed()

    def pour_options(self, pid):
        return [{"slot": p["slot"], "name": p["name"]} for q, p in self.players() if q != pid and self.drinking(q)]

    def pour(self, pid, slot):
        start, until = self.pours.get(pid, (0, 0))
        if not start <= self.now() < until:
            return
        to = next((q for q, p in self.players() if p["slot"] == slot and q != pid), None)
        if to and self.award_sip(to, f"{self.who(pid)['name']} poured you one. Any drink or water counts.", title="A SIP"):
            del self.pours[pid]
            self.notices[pid] = {"title": "POURED", "text": f"Sent. {self.who(to)['name']} has a sip coming.", "at": self.now()}
            self.changed()

    # -- scores

    def add_points(self, pid, pts):
        """Adds to this round's points (never below zero) and the night's."""
        before = self.points.get(pid, 0)
        after = max(0, before + pts)
        self.points[pid] = after
        self.night[pid] = max(0, self.night.get(pid, 0) + after - before)

    def standings(self, table=None):
        """[{pid, place, slot, name, color, points}] best first; equal points share a place."""
        table = self.points if table is None else table
        rows = sorted(((pid, pts) for pid, pts in table.items()), key=lambda e: (-e[1], self.who(e[0])["slot"]))
        out = []
        for i, (pid, pts) in enumerate(rows):
            place = out[-1]["place"] if out and out[-1]["points"] == pts else i + 1
            out.append({"pid": pid, "place": place, **self.who(pid), "points": pts})
        return out

    def podium(self, table=None):
        """The top three places for the wall (no pids)."""
        return [{k: v for k, v in r.items() if k != "pid"} for r in self.standings(table)[:3] if r["points"] > 0]

    # -- views

    def wall(self):
        """What the wall draws. Never says who is or isn't drinking: only "drop" (a sip's time)."""
        now = self.now()
        here = self.players()
        names = [p["name"] for _, p in here]
        return {
            "game": self.key, "title": self.title, "phase": self.phase, "at": self.at, "until": self.until,
            "now": now, "round": self.round,
            "players": [{"slot": p["slot"], "name": p["name"], "initial": ini, "color": p["color"],
                         "points": self.points.get(pid, 0), "drop": self.drops.get(pid) if now - self.drops.get(pid, -1e9) < DROP_FOR else None}
                        for (pid, p), ini in zip(here, initials(names))],
            **self.data,
        }

    def pad(self, pid):
        """What one phone shows. Subclasses return their own pad and call base_pad() for this."""
        return self.base_pad(pid, {"ui": "wait", "big": self.title.upper(), "text": "Eyes on the wall."})

    def base_pad(self, pid, view):
        now = self.now()
        view = {"key": f"{self.phase}:{self.at}", "phase": self.phase, "now": now, "at": self.at, **view}
        note = self.notices.get(pid)
        if note and note["at"] <= now and now - note["at"] < 20:
            view["notice"] = {"title": note["title"], "text": note["text"], "at": note["at"]}
        start, until = self.pours.get(pid, (0, 0))
        if start <= now < until:
            view["pour"] = {"options": self.pour_options(pid), "until": until}
        view["points"] = self.points.get(pid, 0)
        view["sips"] = self.hub.sips_on()
        return view

    # -- input

    def input(self, pid, msg):
        kind = msg["kind"]
        if kind == "pour":
            return self.pour(pid, msg["to"])
        if kind == "start" and self.phase == "lobby":
            return self.start()
        if kind == "next" and self.phase == "podium":
            return self.next_round()
        if kind == "end" and self.phase == "podium":
            return self.go("lobby")
        self.on_input(pid, msg)

    # -- for subclasses

    def start(self):
        self.round, self.night = 0, {}
        self.next_round()

    def next_round(self):
        pass

    def on_input(self, pid, msg):
        pass

    def on_timeout(self):
        pass


# ---------------------------------------------------------------- closest wins

def score_guesses(answer, guesses, doubled=()):
    """Closest Wins' points for one question. guesses: {pid: value}. Closest gets 3, second 2,
    third 1 (equal distances share a place) and spot on gets 5. A DOUBLE doubles what you'd
    have got, or costs 2 if you'd have got nothing. Returns rows furthest first:
    [{pid, value, off, rank, points, doubled}]."""
    rows = [{"pid": pid, "value": v, "off": abs(v - answer)} for pid, v in guesses.items()]
    for r in rows:
        r["rank"] = 1 + sum(1 for o in rows if o["off"] < r["off"])
        pts = 5 if r["off"] == 0 else max(0, 4 - r["rank"])
        r["doubled"] = r["pid"] in doubled
        r["points"] = (pts * 2 if pts else -2) if r["doubled"] else pts
    rows.sort(key=lambda r: (-r["off"], r["pid"]))
    return rows


def reveal_times(n):
    """Closest Wins' reveal, in seconds from its start: when each dot drops (furthest first, the
    last two slower), when the answer falls, when the winner's line shows, and the end."""
    drops, t = [], 1.0
    for i in range(n):
        drops.append(round(t, 2))
        t += 1.2 if i >= n - 2 else 0.8
    answer = t + (0.4 if n else 0)
    line = answer + 1.4
    return {"drops": drops, "answer": round(answer, 2), "line": round(line, 2), "end": round(line + 5.5, 2)}


class ClosestWins(PartyGame):
    """A question with a number answer goes up, everyone guesses on their phone and the closest
    guess wins, so nobody needs to know the answer. Six questions a round; the sixth is DOUBLE
    (each phone can double or lose its points on it, before it's shown); every third round is
    WHAT YEAR?, all release years, including the owner's own years.txt. The furthest guess is
    a sip for a drinker; spot on lets you pour one out."""
    key = "closest"
    title = "Closest Wins"
    DECK = "numbers"
    QUESTIONS = 6
    ASK = 20
    DOUBLE = 9
    CARD = 6
    RELEASE = ("music", "film", "yours")  # WHAT YEAR? rounds are release years

    def __init__(self, hub, rand=None):
        super().__init__(hub, rand)
        self.questions, self.q, self.guesses, self.doubles, self.results = [], -1, {}, set(), {}
        self.go("lobby")

    def years_file(self):
        return os.path.join(self.hub.store.data_dir, "years.txt")

    def own_years(self):
        try:
            with open(self.years_file(), encoding="utf-8") as f:
                return parse_years(f.read())[0]
        except OSError:
            return []

    # -- picking questions

    def pick_questions(self, year_round):
        deck = load_deck(self.DECK)
        used = self.hub.used
        if year_round:
            own = self.own_years()
            picked = used.draw("years", own, min(len(own), self.rand.choice([3, 4]))) if own else []
            release = [i for i in deck if i.get("unit") == "YEAR" and i.get("category") in self.RELEASE]
            picked += used.draw(self.DECK, release, self.QUESTIONS - len(picked), self.rand)
            if len(picked) < self.QUESTIONS:  # a small deck: any year question will do
                more = [i for i in deck if i.get("unit") == "YEAR" and i not in picked]
                picked += used.draw(self.DECK, more, self.QUESTIONS - len(picked), self.rand)
            self.rand.shuffle(picked)
            return picked
        # a normal round: one category at a time, so every kind of fan gets one, and at most one
        # year question (release years are saved for WHAT YEAR? rounds)
        pool = [i for i in deck if not (i.get("unit") == "YEAR" and i.get("category") in self.RELEASE)]
        cats = sorted({i.get("category") for i in pool})
        self.rand.shuffle(cats)
        picked = []
        for n in range(self.QUESTIONS * 3):
            if len(picked) >= self.QUESTIONS or not cats:
                break
            cat = cats[n % len(cats)]
            had_year = any(i.get("unit") == "YEAR" for i in picked)
            options = [i for i in pool if i.get("category") == cat and i not in picked and not (had_year and i.get("unit") == "YEAR")]
            picked += used.draw(self.DECK + ":" + str(cat), options, 1, self.rand) if options else []
        return picked

    # -- the flow

    def next_round(self):
        if not self.players():
            return self.go("lobby")
        self.round += 1
        self.points = {}
        year = self.round % 3 == 0
        self.questions = self.pick_questions(year)
        self.q = -1
        if not self.questions:
            return self.go("lobby", note="The question deck is missing.")
        leaders = self.podium(self.night) if self.round > 1 else []
        self.go("card", self.CARD, kind="year" if year else "number",
                heading="WHAT YEAR?" if year else "CLOSEST WINS",
                lines=["RELEASE YEARS", "MUSIC AND FILM"] if year else ["SIX QUESTIONS", "CLOSEST GUESS WINS"],
                night=leaders)

    def next_question(self):
        self.q += 1
        if self.q >= len(self.questions):
            return self.end_round()
        if not self.players():
            return self.go("lobby")
        self.guesses, self.doubles = {}, set()
        if self.q == len(self.questions) - 1 and len(self.questions) == self.QUESTIONS:
            self.go("double", self.DOUBLE, **self.numbering())
        else:
            self.ask()

    def numbering(self):
        return {"n": self.q + 1, "of": len(self.questions), "double": self.q == self.QUESTIONS - 1}

    def item(self):
        return self.questions[self.q]

    def ask(self):
        it = self.item()
        year = it.get("unit") == "YEAR"
        tag = "WHAT YEAR?" if year and self.round % 3 == 0 else it.get("unit", "")
        self.go("ask", self.ASK, text=it["q"], by=it.get("by", ""), tag=tag, year=year, **self.numbering())

    def reveal(self):
        it = self.item()
        values = {pid: g["value"] for pid, g in self.guesses.items() if g.get("value") is not None and (g["locked"] or g["touched"])}
        rows = score_guesses(it["answer"], values, self.doubles)
        times = reveal_times(len(rows))
        start = self.now()
        year = it.get("unit") == "YEAR"
        for r in rows:
            self.add_points(r["pid"], r["points"])
        self.results = {r["pid"]: r for r in rows}
        # the furthest guess is a sip for a drinker (nobody else); spot on may pour one out
        furthest = rows[0]["off"] if len(rows) >= 2 and rows[0]["off"] > rows[-1]["off"] else None
        for r in rows:
            r["sip"] = furthest is not None and r["off"] == furthest and self.award_sip(
                r["pid"], "Furthest guess. Any drink or water counts.", at=start + times["answer"] + 0.6)
            if r["off"] == 0:
                self.offer_pour(r["pid"], at=start + times["line"])
        best = [r for r in rows if r["rank"] == 1]
        if not rows:
            winner = "NOBODY LOCKED IN"
        else:
            names = [self.who(r["pid"])["name"] for r in best]
            who = names[0] if len(names) == 1 else f"{names[0]} & {names[1]}" if len(names) == 2 else f"{len(names)} TIED"
            winner = f"{who}, SPOT ON" if best[0]["off"] == 0 else f"{who}, {fmt(best[0]['off'])} AWAY"
        here = self.players()
        ini = dict(zip([pid for pid, _ in here], initials([p["name"] for _, p in here])))
        lo = min([it.get("min", it["answer"]), it["answer"]] + [r["value"] for r in rows])
        hi = max([it.get("max", it["answer"]), it["answer"]] + [r["value"] for r in rows])
        self.wake(start + times["answer"])
        self.go("reveal", times["end"], text=it["q"], by=it.get("by", ""), year=year, answer=it["answer"],
                answerText=fmt(it["answer"], year), unit=it.get("unit", ""), min=lo, max=hi,
                spot=bool(rows) and rows[-1]["off"] == 0, winner=winner, times=times,
                rows=[{"slot": self.who(r["pid"])["slot"], "name": self.who(r["pid"])["name"],
                       "initial": ini.get(r["pid"]) or self.who(r["pid"])["name"][:1], "color": self.who(r["pid"])["color"],
                       "value": r["value"], "rank": r["rank"], "points": r["points"], "doubled": r["doubled"], "sip": r["sip"]}
                      for r in rows],
                **self.numbering())

    def end_round(self):
        if not any(self.points.values()):
            return self.go("lobby")
        self.go("podium", None, places=self.podium(), label="ROUND " + str(self.round))

    def on_timeout(self):
        if self.phase == "card":
            self.next_question()
        elif self.phase == "double":
            self.ask()
        elif self.phase == "ask":
            self.reveal()
        elif self.phase == "reveal":
            self.next_question()

    def on_input(self, pid, msg):
        kind = msg["kind"]
        if self.phase == "double" and kind == "toggle" and msg["id"] == "double":
            (self.doubles.add if msg["on"] else self.doubles.discard)(pid)
            self.changed()
        elif self.phase == "ask" and kind in ("number", "lock"):
            it = self.item()
            g = self.guesses.setdefault(pid, {"value": None, "locked": False, "touched": False})
            if g["locked"]:
                return
            value = msg.get("value")
            if value is not None:
                step = it.get("step") or 1
                g["value"] = min(it["max"], max(it["min"], int(round(value / step) * step)))
                g["touched"] = True
            if kind == "lock" and g["value"] is not None:
                g["locked"] = True
                self.changed()
                here = [q for q, _ in self.players()]
                if here and all(self.guesses.get(q, {}).get("locked") for q in here):
                    self.until = min(self.until or 1e18, self.now() + 1.0)

    # -- views

    def wall(self):
        view = super().wall()
        if self.phase == "ask":
            view["locks"] = [{"slot": p["slot"], "locked": bool(self.guesses.get(pid, {}).get("locked"))} for pid, p in self.players()]
        if self.phase == "lobby":
            view["lines"] = ["A NUMBER QUESTION", "GUESS ON YOUR PHONE", "CLOSEST WINS"]
        return view

    def pad(self, pid):
        ph = self.phase
        if ph == "lobby":
            return self.base_pad(pid, {"ui": "start", "big": "Closest Wins", "label": "Start",
                                       "text": "A question with a number answer goes up on the wall. Guess on your phone; the closest guess wins, so nobody needs to know it."})
        if ph == "card":
            return self.base_pad(pid, {"ui": "wait", "title": f"Round {self.round}", "big": self.data["heading"].title(), "text": "Eyes on the wall."})
        if ph == "double":
            return self.base_pad(pid, {"ui": "toggle", "id": "double", "label": "DOUBLE", "on": pid in self.doubles, "deadline": self.until,
                                       "title": f"Question {self.q + 1} · before you see it",
                                       "text": "Twice the points if you place. Lose 2 if you don't."})
        if ph == "ask":
            it = self.item()
            g = self.guesses.get(pid) or {}
            year = it.get("unit") == "YEAR"
            mid = (it["min"] + it["max"]) / 2
            step = it.get("step") or 1
            return self.base_pad(pid, {
                "ui": "number", "key": f"ask:{self.at}", "min": it["min"], "max": it["max"], "step": step, "year": year,
                "unit": "YEAR" if year else it.get("unit", ""), "start": int(round(mid / step) * step),
                "value": g.get("value"), "locked": bool(g.get("locked")), "deadline": self.until,
                "title": f"Question {self.q + 1} of {len(self.questions)}" + (" · DOUBLE" if pid in self.doubles else ""),
            })
        if ph == "reveal":
            r = self.results.get(pid)
            if self.now() < self.at + self.data["times"]["answer"]:
                g = self.guesses.get(pid) or {}
                text = f"You said {fmt(g['value'], self.data['year'])}." if r else "No guess this time."
                return self.base_pad(pid, {"ui": "wait", "key": f"reveal:{self.at}:wait", "big": "Eyes on the wall", "text": text})
            if not r:
                return self.base_pad(pid, {"ui": "result", "key": f"reveal:{self.at}", "big": "No guess", "text": "Get the next one in.", "tone": "plain"})
            off = "Spot on" if r["off"] == 0 else f"You were {fmt(r['off'])} off"
            pts = f"+{r['points']}" if r["points"] > 0 else f"{r['points']}" if r["points"] < 0 else "no points"
            return self.base_pad(pid, {"ui": "result", "key": f"reveal:{self.at}", "big": ordinal(r["rank"]),
                                       "text": f"{off} · {pts}" + (" (doubled)" if r["doubled"] else ""),
                                       "tone": "win" if r["off"] == 0 or r["rank"] == 1 else "good" if r["points"] > 0 else "plain"})
        if ph == "podium":
            mine = next((s for s in self.standings() if s["pid"] == pid), None)
            big = ordinal(mine["place"]) if mine and mine["points"] > 0 else "Round over"
            text = f"{mine['points']} point{'s' if mine['points'] != 1 else ''} this round." if mine else "Join in next round."
            return self.base_pad(pid, {"ui": "next", "big": big, "text": text,
                                       "buttons": [{"kind": "next", "label": "Next round"}, {"kind": "end", "label": "Finish"}]})
        return super().pad(pid)


# ---------------------------------------------------------------- five clues

# The deck's card types, grouped so a round of six has one of each kind of fan's card.
CLUE_GROUPS = {"A FOOTBALLER": "football", "A RAPPER": "hiphop", "A PRODUCER": "hiphop", "A DJ": "dance",
               "A FILM": "film", "A DUBAI PLACE": "dubai", "POP CULTURE": "pop"}


def leaders_line(rows):
    """Between cards, the one line the wall shows: SAMI LEADS, SAMI & LAYLA LEAD, 3-WAY TIE."""
    top = [r["name"] for r in rows if r["place"] == 1 and r["points"] > 0]
    if not top:
        return "NO SCORES YET"
    if len(top) == 1:
        return f"{top[0]} LEADS"
    return f"{top[0]} & {top[1]} LEAD" if len(top) == 2 else f"{len(top)}-WAY TIE"


class FiveClues(PartyGame):
    """A hidden footballer, rapper, film or Dubai place, revealed one clue at a time, hardest
    first, and worth 5 points on the first clue down to 1 on the last. Anyone can buzz; the first
    buzz to reach the Pi wins, and that phone alone gets four options. Right banks the points;
    wrong (or too slow) locks that player out of the card and the clues carry on for everyone
    else. Six cards a round, one of each type. A wrong buzz is a sip for a drinker; getting it on
    the first clue lets you pour one out."""
    key = "fiveclues"
    title = "Five Clues"
    DECK = "clues"
    CARDS = 6
    CARD = 6      # the between-rounds card
    CLUE = 6      # seconds per clue before the next, easier one (and the value drops)
    LAST = 8      # the fifth clue stays up a little longer
    PICK = 8      # seconds the buzzer has to pick
    MISS = 2.5    # a wrong pick, crossed out, before the clues carry on
    RESUME = 3    # after a miss the clue gets at least this long again
    GUARD = 0.3   # buzzes this soon after a clue appears are ignored: nobody wins on a stale screen
    REVEAL = 5
    LEADS = 3

    def __init__(self, hub, rand=None):
        super().__init__(hub, rand)
        self.cards, self.c, self.k = [], -1, 0
        self.out, self.buzzer, self.options, self.left, self.got = set(), None, [], 0, None
        self.go("lobby")

    # -- picking cards

    def pick_cards(self):
        """One card of each group, in a shuffled order, from the cards not played yet."""
        deck = [i for i in load_deck(self.DECK) if len(i.get("clues") or []) == 5 and len(i.get("decoys") or []) >= 3]
        groups = {}
        for i in deck:
            groups.setdefault(CLUE_GROUPS.get(i.get("type"), i.get("type")), []).append(i)
        names = sorted(groups)
        self.rand.shuffle(names)
        picked = []
        for n in range(self.CARDS):
            if not names:
                break
            group = names[n % len(names)]
            options = [i for i in groups[group] if i not in picked]
            picked += self.hub.used.draw(f"{self.DECK}:{group}", options, 1, self.rand) if options else []
        return picked

    # -- the flow

    def next_round(self):
        if not self.players():
            return self.go("lobby")
        self.round += 1
        self.points = {}
        self.cards, self.c = self.pick_cards(), -1
        if not self.cards:
            return self.go("lobby", note="The clue deck is missing.")
        self.go("card", self.CARD, heading="FIVE CLUES", lines=["SIX CARDS", "BUZZ WHEN YOU KNOW"],
                night=self.podium(self.night) if self.round > 1 else [])

    def item(self):
        return self.cards[self.c]

    def value(self):
        return 6 - self.k

    def next_card(self):
        self.c += 1
        if self.c >= len(self.cards):
            return self.end_round()
        if not self.players():
            return self.go("lobby")
        self.out, self.buzzer, self.got = set(), None, None
        self.show_clue(1)

    def show_clue(self, k, secs=None):
        self.k = k
        self.go("clue", secs if secs is not None else self.LAST if k == 5 else self.CLUE, **self.card_view())

    def card_view(self):
        """What the wall may know mid-card: the clues so far, never the answer or the options.
        (The card's type goes out as "category": "type" is the message's own.)"""
        it = self.item()
        return {"n": self.c + 1, "of": len(self.cards), "category": it["type"], "clues": it["clues"][:self.k],
                "k": self.k, "value": self.value(), "card": it["id"]}

    def buzz(self, pid):
        if self.phase != "clue" or pid in self.out or self.now() - self.at < self.GUARD:
            return
        it = self.item()
        self.buzzer = pid
        self.left = max(self.RESUME, (self.until or self.now()) - self.now())
        self.options = [it["answer"]] + list(it["decoys"][:3])
        self.rand.shuffle(self.options)
        p = self.who(pid)
        self.go("buzz", self.PICK, buzzer={"slot": p["slot"], "name": p["name"], "color": p["color"]}, **self.card_view())

    def pick(self, pid, msg):
        if self.phase != "buzz" or pid != self.buzzer:
            return
        label = msg.get("id")
        if label not in self.options:
            n = msg.get("choice")
            label = self.options[n] if isinstance(n, int) and 0 <= n < len(self.options) else None
        if label is None:
            return
        if label == self.item()["answer"]:
            self.add_points(pid, self.value())
            self.reveal(pid)
        else:
            self.miss(pid, label)

    def miss(self, pid, label):
        """A wrong pick (label None: time ran out): out of this card, and a sip for a drinker."""
        self.out.add(pid)
        self.award_sip(pid, "Wrong buzz. Any drink or water counts.")
        self.go("miss", self.MISS, buzzer=self.data.get("buzzer"), wrong=label, **self.card_view())

    def reveal(self, pid=None):
        it = self.item()
        self.got, self.buzzer = pid, None
        winner = None
        if pid:
            p = self.who(pid)
            winner = {"slot": p["slot"], "name": p["name"], "color": p["color"], "points": self.value()}
            if self.k == 1:
                self.offer_pour(pid, at=self.now() + 1.5)
        self.go("reveal", self.REVEAL, n=self.c + 1, of=len(self.cards), category=it["type"], answer=it["answer"],
                k=self.k, winner=winner, spot=bool(pid) and self.k == 1)

    def after_reveal(self):
        if self.c + 1 >= len(self.cards):
            return self.end_round()
        self.go("leads", self.LEADS, n=self.c + 1, of=len(self.cards), line=leaders_line(self.standings()),
                next=self.cards[self.c + 1]["type"])

    def end_round(self):
        self.go("podium", None, places=self.podium(), label="ROUND " + str(self.round))

    def on_timeout(self):
        ph = self.phase
        if ph == "card" or ph == "leads":
            self.next_card()
        elif ph == "clue":
            self.show_clue(self.k + 1) if self.k < 5 else self.reveal()
        elif ph == "buzz":
            self.miss(self.buzzer, None)
        elif ph == "miss":
            here = [q for q, _ in self.players()]
            if not here or all(q in self.out for q in here):
                self.reveal()
            else:
                self.show_clue(self.k, self.left)
        elif ph == "reveal":
            self.after_reveal()

    def on_input(self, pid, msg):
        if msg["kind"] in ("buzz", "tap"):
            self.buzz(pid)
        elif msg["kind"] == "pick":
            self.pick(pid, msg)

    # -- views

    def wall(self):
        view = super().wall()
        if self.phase in ("clue", "buzz", "miss"):
            # every player's dot, hollow once they're locked out of this card
            view["locks"] = [{"slot": p["slot"], "locked": pid not in self.out} for pid, p in self.players()]
        if self.phase == "lobby":
            view["lines"] = ["FIVE CLUES, ONE ANSWER", "BUZZ WHEN YOU KNOW", "WRONG BUZZ, YOU'RE OUT"]
        return view

    def pad(self, pid):
        ph = self.phase
        if ph == "lobby":
            return self.base_pad(pid, {"ui": "start", "big": "Five Clues", "label": "Start",
                                       "text": "Five clues, hardest first, and the points drop with each one. Buzz when you know it; a wrong buzz locks you out of that card."})
        if ph == "card":
            return self.base_pad(pid, {"ui": "wait", "title": f"Round {self.round}", "big": "Five Clues", "text": "Eyes on the wall."})
        if ph in ("clue", "buzz", "miss"):
            title = f"Card {self.c + 1} of {len(self.cards)}"
            if ph == "buzz" and pid == self.buzzer:
                return self.base_pad(pid, {"ui": "pick", "key": f"pick:{self.at}", "title": f"{title} · for {self.value()}",
                                           "options": [{"id": o, "label": o} for o in self.options], "cols": 2,
                                           "lockOnPick": True, "deadline": self.until})
            if ph == "miss" and pid == self.buzzer:
                wrong = self.data.get("wrong")
                return self.base_pad(pid, {"ui": "result", "key": f"miss:{self.at}", "title": title,
                                           "big": "Not it" if wrong else "Too slow", "tone": "plain",
                                           "text": f"It wasn't {wrong}. You're out of this card." if wrong else "Time ran out. You're out of this card."})
            pts = f"{self.value()} point{'s' if self.value() != 1 else ''}"
            if pid in self.out:
                view = {"locked": True, "text": "Locked out"}
            elif ph != "clue":
                view = {"locked": True, "text": f"{self.data['buzzer']['name']} buzzed"}
            else:
                view = {"locked": False}
            # one pad per card: the value and the lock change in place, so a press is never lost to a rebuild
            return self.base_pad(pid, {"ui": "buzz", "key": f"card:{self.round}:{self.c}",
                                       "title": title, "label": "BUZZ", "value": pts,
                                       "deadline": self.until if ph == "clue" else None, **view})
        if ph == "reveal":
            it = self.item()
            w = self.data.get("winner")
            if self.got == pid:
                return self.base_pad(pid, {"ui": "result", "big": f"+{w['points']}", "tone": "win",
                                           "text": f"{it['answer']}, on clue {self.k}."})
            return self.base_pad(pid, {"ui": "result", "big": it["answer"], "tone": "plain",
                                       "text": f"{w['name']} got it on clue {self.k}." if w else "Nobody got it."})
        if ph == "leads" or ph == "podium":
            mine = next((s for s in self.standings() if s["pid"] == pid), None)
            pts = mine["points"] if mine else 0
            big = ordinal(mine["place"]) if pts > 0 else ("Round over" if ph == "podium" else "No points yet")
            text = f"{pts} point{'s' if pts != 1 else ''} this round." if pts else "Buzz in on the next one."
            if ph == "leads":
                return self.base_pad(pid, {"ui": "result", "title": f"Card {self.c + 1} of {len(self.cards)} done",
                                           "big": big, "text": text, "tone": "good" if pts else "plain"})
            return self.base_pad(pid, {"ui": "next", "big": big, "text": text if mine else "Join in next round.",
                                       "buttons": [{"kind": "next", "label": "Next round"}, {"kind": "end", "label": "Finish"}]})
        return super().pad(pid)


# ---------------------------------------------------------------- five lights

# The tiers of the Five Lights deck, mildest first. The host picks one before starting; Cheeky is
# the ceiling (nothing sexual, nothing about bodies, money or exes).
TIERS = {"mild": "MILD", "dubai": "DUBAI LIFE", "cheeky": "CHEEKY"}
HOUSE_MAX = 40  # characters: a house prompt still has to fit the wall in four lines


def parse_house(text):
    """The group's own Five Lights prompts (house.txt, from the box on the control page): one per
    line, the part after "Never have I ever" (which is dropped if it's typed too). Blank lines and
    lines starting with # are skipped. Returns (items, bad line numbers: too long to fit)."""
    items, bad, seen = [], [], set()
    for n, raw in enumerate((text or "").splitlines(), 1):
        line = " ".join(raw.split())
        if not line or line.startswith("#"):
            continue
        line = re.sub(r"^never\s+have\s+i\s+ever[\s,.:…-]*", "", line, flags=re.I).rstrip(" .!").upper()
        if not line:
            continue
        if len(line) > HOUSE_MAX:
            bad.append(n)
            continue
        uid = "h-" + hashlib.sha1(line.encode()).hexdigest()[:10]
        if uid not in seen:
            seen.add(uid)
            items.append({"id": uid, "text": line, "tier": "house", "room": False})
    return items, bad


def out_times(n):
    """Five Lights' reveal, in seconds from its start: the count shows at once, the names light up,
    then each "I have" bulb goes out in turn. Returns when each goes out, when TELL IT opens and
    the end (time enough to decide to tell it)."""
    outs = [round(2.4 + 0.75 * i, 2) for i in range(n)]
    tell = (outs[-1] if outs else 1.6) + 0.6
    return {"outs": outs, "tell": round(tell, 2), "end": round(tell + (5.0 if n else 3.0), 2)}


class FiveLights(PartyGame):
    """Never Have I Ever on the wall. Everyone starts with five gold bulbs. A prompt goes up, every
    phone answers I HAVE or NEVER at once (changeable until the clock runs out), then the wall says
    how many have, lights up their names and puts one bulb out for each. Losing a bulb is a sip for
    a drinker. Anyone who has can tap TELL IT for 30 seconds of the wall. Every fifth prompt is a
    Room prompt: only the percentage shows, no names and no bulbs. Last one lit wins; Relight
    starts again. Players who are out keep answering for fun, and late arrivals come in with as
    many bulbs as whoever has fewest."""
    key = "fivelights"
    title = "Five Lights"
    DECK = "nights"
    BULBS = 5
    ASK = 10
    CARD = 6
    STORY = 30
    ROOM_EVERY = 5   # every fifth prompt is a Room prompt
    HOUSE_EVERY = 4  # one regular prompt in four is a house prompt, while there are any
    LOWER_EVERY = 3  # and one in three comes from the milder tiers (Dubai and Cheeky nights)

    def __init__(self, hub, rand=None):
        super().__init__(hub, rand)
        self.bulbs = {}      # pid -> bulbs still lit, this game
        self.answers = {}    # pid -> True (I have) / False (never), this prompt
        self.n = 0           # prompts so far this game
        self.regular = 0     # regular (not Room) prompts so far this game
        self.prompt = None
        self.teller = None   # who's telling the story of this prompt
        self.lit_before = []  # who was lit before this reveal: they share it if everyone goes out
        self.go("lobby")

    # -- settings

    def tier(self):
        tier = self.hub.store.state["channels"]["games"].get("tier")
        return tier if tier in TIERS else "mild"

    def house_file(self):
        return os.path.join(self.hub.store.data_dir, "house.txt")

    def house(self):
        try:
            with open(self.house_file(), encoding="utf-8") as f:
                return parse_house(f.read())[0]
        except OSError:
            return []

    # -- players

    def players(self):
        here = super().players()
        if self.phase != "lobby" and self.bulbs:
            # someone arriving mid-game comes in level with whoever has fewest bulbs still lit
            lit = [n for n in self.bulbs.values() if n > 0]
            for pid, _ in here:
                if pid not in self.bulbs:
                    self.bulbs[pid] = min(lit) if lit else 0
        return here

    def lit(self):
        return [pid for pid, _ in self.players() if self.bulbs.get(pid, 0) > 0]

    # -- picking prompts

    def pick_prompt(self, room):
        deck = load_deck(self.DECK)
        tiers = list(TIERS)
        tier = self.tier()
        milder = tiers[:tiers.index(tier)]
        used = self.hub.used
        if room:
            # Room prompts come from the chosen tier and the milder ones: they're the soft ones
            pool = [i for i in deck if i.get("room") and i.get("tier") in milder + [tier]]
            picked = used.draw(self.DECK + ":room", pool, 1, self.rand)
            if picked:
                return picked[0]
        self.regular += 1
        house = self.house()
        if house and self.regular % self.HOUSE_EVERY == 2:
            return used.draw("house", house, 1, self.rand)[0]
        if milder and self.regular % self.LOWER_EVERY == 0:
            tier = self.rand.choice(milder)
        pool = [i for i in deck if i.get("tier") == tier and not i.get("room")]
        picked = used.draw(self.DECK + ":" + tier, pool, 1, self.rand) or used.draw(self.DECK + ":room", [i for i in deck if i.get("room")], 1, self.rand)
        return picked[0] if picked else None

    # -- the flow

    def input(self, pid, msg):
        if msg["kind"] == "start" and self.phase == "lobby" and len(self.players()) < 2:
            self.notices[pid] = {"title": "ONE MORE", "text": "Five Lights needs at least two phones.", "at": self.now()}
            return self.changed()
        super().input(pid, msg)

    def next_round(self):
        """A new game (Relight): everyone here gets five bulbs again."""
        here = self.players()
        if len(here) < 2:
            return self.go("lobby")
        self.round += 1
        self.points = {}
        self.bulbs = {pid: self.BULBS for pid, _ in here}
        self.n = self.regular = 0
        self.drops = {}
        leaders = self.podium(self.night) if self.round > 1 else []
        self.go("card", self.CARD, heading="FIVE LIGHTS", lines=["FIVE BULBS EACH", "LAST ONE LIT WINS", TIERS[self.tier()] + " PROMPTS"], night=leaders)

    def next_prompt(self):
        if len(self.lit()) <= 1:
            return self.end_game()
        self.n += 1
        room = self.n % self.ROOM_EVERY == 0
        item = self.pick_prompt(room)
        if not item:
            return self.go("lobby", note="The prompt deck is missing.")
        room = room and bool(item.get("room"))
        self.prompt = {"id": item["id"], "text": item["text"], "room": room, "house": item.get("tier") == "house"}
        self.answers, self.teller = {}, None
        self.go("ask", self.ASK, text=item["text"], room=room, n=self.n)

    def reveal(self):
        here = self.players()
        said = {pid: self.answers[pid] for pid, _ in here if pid in self.answers}
        have = [pid for pid, _ in here if said.get(pid)]
        text = self.prompt["text"]
        if self.prompt["room"]:
            pct = round(100 * len(have) / len(said)) if said else 0
            return self.go("reveal", 7, room=True, text=text, answered=len(said), pct=pct, n=self.n)
        self.lit_before = self.lit()
        losing = [pid for pid in have if self.bulbs.get(pid, 0) > 0]
        times = out_times(len(losing))
        start = self.now()
        outs = []
        for pid, at in zip(losing, times["outs"]):
            self.bulbs[pid] -= 1
            outs.append({"slot": self.who(pid)["slot"], "at": at, "left": self.bulbs[pid]})
            self.award_sip(pid, "You have: a bulb out, and a sip. Any drink or water counts.", at=start + at)
            self.wake(start + at)
        self.wake(start + times["tell"])
        self.go("reveal", times["end"], room=False, text=text, answered=len(said), count=len(have), n=self.n,
                have=[self.who(pid)["slot"] for pid in have], outs=outs, times=times)

    def after_prompt(self):
        if len(self.lit()) <= 1:
            return self.end_game()
        self.next_prompt()

    def end_game(self):
        here = dict(self.players())
        lit = self.lit()
        # one left lit wins; if the last ones all went out together, they share it
        winners = lit or [pid for pid in self.lit_before if pid in here]
        if not winners:
            return self.go("lobby")
        for pid in winners:
            self.night[pid] = self.night.get(pid, 0) + 1
        self.go("podium", None, label="ROUND " + str(self.round),
                winners=[{k: self.who(pid)[k] for k in ("slot", "name", "color")} for pid in winners],
                spare=self.bulbs.get(winners[0], 0) if len(winners) == 1 else 0)

    def on_timeout(self):
        if self.phase == "card":
            self.next_prompt()
        elif self.phase == "ask":
            self.reveal()
        elif self.phase == "reveal":
            if self.teller:
                p = self.who(self.teller)
                self.go("story", self.STORY, text=self.prompt["text"], slot=p["slot"], name=p["name"], color=p["color"])
            else:
                self.after_prompt()
        elif self.phase == "story":
            self.after_prompt()

    def can_tell(self, pid):
        return (self.phase == "reveal" and not self.data.get("room") and not self.teller
                and self.who(pid)["slot"] in self.data.get("have", ()) and self.now() >= self.at + self.data["times"]["tell"])

    def on_input(self, pid, msg):
        kind = msg["kind"]
        if self.phase == "lobby" and kind == "pick" and msg.get("id") in TIERS:
            self.hub.store.update_channels({"games": {"tier": msg["id"]}})
            self.changed()
        elif self.phase == "ask" and kind == "yesno":
            self.answers[pid] = msg["yes"]
            self.changed()
            # everyone has answered: two more seconds to change your mind, then the reveal
            if all(q in self.answers for q, _ in self.players()):
                self.until = min(self.until or 1e18, self.now() + 2.0)
        elif kind == "buzz" and self.can_tell(pid):
            self.teller = pid
            self.until = min(self.until or 1e18, self.now() + 1.0)
            self.changed()
        elif self.phase == "story" and kind == "next" and self.who(pid)["slot"] == self.data["slot"]:
            self.after_prompt()

    # -- views

    def wall(self):
        view = super().wall()
        here = self.players()
        for (pid, _), p in zip(here, view["players"]):
            p["lit"] = self.bulbs.get(pid, self.BULBS) if self.phase != "lobby" else self.BULBS
            if self.phase == "ask":
                p["answered"] = pid in self.answers
        if self.phase == "lobby":
            view["lines"] = ["NEVER HAVE I EVER", "FIVE BULBS EACH", TIERS[self.tier()] + " PROMPTS"]
        return view

    def pad(self, pid):
        ph = self.phase
        view = None
        if ph == "lobby":
            view = {"ui": "start", "big": "Five Lights", "label": "Start", "choices": [{"id": k, "label": v.split()[0].title()} for k, v in TIERS.items()],
                    "chosen": self.tier(), "choicesTitle": "Tonight's prompts",
                    "text": "Never Have I Ever. Everyone answers at once on their phone, and each “I have” puts out one of your five bulbs. Last one lit wins."}
        elif ph == "card":
            view = {"ui": "wait", "title": f"Round {self.round}", "big": "Five Lights", "text": "Eyes on the wall."}
        elif ph == "ask":
            room = self.data["room"]
            view = {"ui": "yesno", "key": f"ask:{self.at}", "yes": "I have", "no": "Never", "pair": True, "chosen": self.answers.get(pid),
                    "deadline": self.until, "lead": "Never have I ever", "prompt": self.data["text"],
                    "title": "The room · no names" if room else f"Prompt {self.n}",
                    "text": "Only the percentage shows. Nobody loses a bulb." if room else "Change your mind until the clock runs out."}
        elif ph == "reveal":
            view = self.reveal_pad(pid)
        elif ph == "story":
            if self.who(pid)["slot"] == self.data["slot"]:
                view = {"ui": "next", "big": "Your story", "text": "The wall is yours for 30 seconds. Tap Done when it's told.",
                        "buttons": [{"kind": "next", "label": "Done"}]}
            else:
                view = {"ui": "wait", "big": "Story time", "text": f"{self.data['name']} has the floor."}
        elif ph == "podium":
            won = any(w["slot"] == self.who(pid)["slot"] for w in self.data["winners"])
            names = " & ".join(w["name"] for w in self.data["winners"])
            view = {"ui": "next", "big": "Last one lit" if won else "Relight?", "text": "You win this one." if won else f"{names} wins this one.",
                    "buttons": [{"kind": "next", "label": "Relight"}, {"kind": "end", "label": "Finish"}]}
        if view is None:
            return super().pad(pid)
        if ph != "lobby" and pid in self.bulbs:
            view["lights"] = {"lit": self.lit_shown(pid), "of": self.BULBS}
        return self.base_pad(pid, view)

    def lit_shown(self, pid):
        """Bulbs lit as the phone shows them: one going out in a reveal goes out with the wall."""
        n = self.bulbs.get(pid, 0)
        if self.phase == "reveal" and not self.data.get("room"):
            slot = self.who(pid)["slot"]
            n += sum(1 for o in self.data["outs"] if o["slot"] == slot and self.now() < self.at + o["at"])
        return n

    def reveal_pad(self, pid):
        if self.data["room"]:
            return {"ui": "result", "big": f"{self.data['pct']}%", "text": "of the room have. No names, no bulbs.", "tone": "plain"}
        said = self.answers.get(pid)
        slot = self.who(pid)["slot"]
        out = next((o for o in self.data["outs"] if o["slot"] == slot), None)
        if self.now() < self.at + (out["at"] if out else 1.6):
            return {"ui": "wait", "key": f"reveal:{self.at}:wait", "big": "Eyes on the wall", "text": "I have." if said else "Never." if said is False else "No answer this time."}
        key = f"reveal:{self.at}:{'tell' if self.can_tell(pid) else 'told' if self.teller else 'done'}"
        left = self.bulbs.get(pid, 0)
        if said:
            text = (f"One bulb out. {left} left." if left else "Your last bulb is out. Keep playing along.") if out else "You have. No bulbs left to lose."
            if self.teller == pid:
                text = "Story's yours next."
            buttons = [{"kind": "buzz", "label": "Tell it", "quiet": True}] if self.can_tell(pid) else []
            return {"ui": "next", "key": key, "big": "You have", "text": text, "buttons": buttons}
        if said is False:
            return {"ui": "result", "key": key, "big": "Never", "text": f"Still {left} lit." if left else "Clean on this one.", "tone": "good"}
        return {"ui": "result", "key": key, "big": "No answer", "text": "Get the next one in.", "tone": "plain"}


PARTY_GAMES = {"closest": ClosestWins, "fiveclues": FiveClues, "fivelights": FiveLights}
