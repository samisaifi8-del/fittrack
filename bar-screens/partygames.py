"""Party games the Pi referees: the shared game kit, and Closest Wins.

The arcade games (static/games.js) run on the wall and only use the Pi to pass controller input
along. Quiz and vote games are different: everyone answers at once, nobody should see anyone
else's answer, the decks mustn't repeat and points have to be fair, so the Pi runs them. A game
here is a small state machine (PartyGame) that GameHub ticks four times a second. Each change
goes out over the game stream as two views: one for the wall (what everyone in the room sees)
and one per phone (only that player's own controls and result). The wall draws its view with
static/party.js and the phones build their pads from theirs in static/play.html.

Writing a new party game (Five Clues, Five Lights, The Verdict, Colours):

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
# countdown bar runs to), "notice" ({title, text}: a sip), "pour" ({options: [{slot, name}]}).
#   wait    {big, text}                         eyes on the wall
#   start   {big, text, label}                  a lobby: the Start button
#   number  {min, max, step, year, unit, value, locked}   the dial, with LOCK
#   pick    {options: [{id, label, color?}], cols, chosen, locked}   2x2 grid or a list of names
#   buzz    {label, value, locked, text}        one big BUZZ
#   yesno   {yes, no, chosen, locked}           a pair of buttons
#   toggle  {id, label, on, text}               one switch, e.g. DOUBLE
#   result  {big, text, tone}                   how you did (tone: win / good / plain)
#   next    {big, text, buttons: [{kind, label}]}   end of a round
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


PARTY_GAMES = {"closest": ClosestWins}
