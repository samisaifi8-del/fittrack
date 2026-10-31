"""Party games the Pi referees: the shared game kit, Closest Wins and Colours.

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
#   tap {n?}                 n taps since the last send (a mash pad batches them)
#   call {home, away, lock}  a score call (Colours)    goal {side: home/away}   the room saw a goal
#   undo                     take the last goal back   fulltime, resume   the final whistle, or not yet
INPUTS = ("move", "dir", "tap", "start", "buzz", "next", "end", "pick", "number", "lock", "yesno", "toggle", "pour",
          "call", "goal", "undo", "fulltime", "resume")

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
#   mash    {label, text, color, ink}           one huge button to tap as fast as you can (sends tap {n})
#   call    {home, away, value, locked}         Colours: +/- per club and LOCK (teams are {abbr, name, color, ink})
#   goal    {home, away, score, undo}           Colours: a GOAL button per club, full time, and "no goal"
PADS = ("wait", "start", "number", "pick", "buzz", "yesno", "toggle", "result", "next", "mash", "call", "goal")

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
            view["notice"] = {"title": note["title"], "text": note["text"], "at": note["at"], "plain": bool(note.get("plain"))}
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


# ---------------------------------------------------------------- colours

GOLD = "#b89a63"
IVORY = "#ece4d4"
HOUSE_IVORY = "#c4beb2"  # ivory for a whole field: a little lower, so it reads as ivory, not white
DIM = 0.6          # a club's colour at 60%, so a big field of it doesn't glare in a dim room
NEAR_BLACK = 0.008  # a dimmed colour darker than this (relative luminance) looks like the wall is off
CLASH = 70         # two dimmed colours closer than this (RGB distance) look like the same colour
INK_DARK = 0.2     # on a field brighter than this, type is black instead of ivory


def _rgb(c):
    return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))


def dim(c, keep=DIM):
    return "#" + "".join(f"{max(0, min(255, round(v * keep))):02x}" for v in _rgb(c))


def luminance(c):
    lin = [v / 255 / 12.92 if v <= 10 else ((v / 255 + 0.055) / 1.055) ** 2.4 for v in _rgb(c)]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def ink(c):
    """Type on a field of colour c: ivory, or black on a light one (a white club's grey)."""
    return "#000000" if luminance(c) > INK_DARK else IVORY


def club_colours(home, away):
    """Which colour each half of the wall is: the clubs' ESPN colours, unless one would look like
    black once dimmed (then its alternate colour), or the two would look the same (then the away
    club's alternate, then the home club's). A club with no usable colour at all is ivory or gold,
    whichever stands further from the other; failing everything, gold against ivory.
    Returns (home colour, away colour, "espn" / "alternate" / "house"), undimmed."""
    def options(t):
        return [c for c in (t.get("color"), t.get("alt")) if c and luminance(dim(c)) >= NEAR_BLACK]
    apart = lambda h, a: sum((x - y) ** 2 for x, y in zip(_rgb(dim(h)), _rgb(dim(a)))) ** 0.5
    hs, aw = options(home), options(away)
    if bool(hs) != bool(aw):  # one club is all near-black: the house colour that suits best
        other = (hs or aw)[0]
        house = max((HOUSE_IVORY, GOLD), key=lambda c: apart(c, other))
        hs, aw = hs or [house], aw or [house]
    pairs = [(h, a) for h in hs[:1] for a in aw] + [(h, a) for h in hs[1:] for a in aw]
    for h, a in pairs:
        if apart(h, a) >= CLASH:
            return h, a, "espn" if h == home.get("color") and a == away.get("color") else "alternate" if h in (home.get("color"), home.get("alt")) and a in (away.get("color"), away.get("alt")) else "house"
    return GOLD, HOUSE_IVORY, "house"


def call_points(call, home, away):
    """A score call's points at full time: 3 for the exact score, 1 for the right result."""
    if (call[0], call[1]) == (home, away):
        return 3
    return 1 if (call[0] > call[1]) - (call[0] < call[1]) == (home > away) - (home < away) else 0


def worst_calls(rows):
    """Who pours: of tonight's calls (rows of {name, points, off}), the fewest points, then the
    most goals out. Nobody if fewer than two called or they all did as well; at most two names."""
    if len(rows) < 2:
        return []
    rank = lambda r: (r["points"], -r["off"])
    worst = min(rank(r) for r in rows)
    if all(rank(r) == worst for r in rows):
        return []
    names = [r["name"] for r in rows if rank(r) == worst]
    return names if len(names) <= 2 else []


class Season:
    """Colours' grudge table, in the data folder (colours.json) across nights: points per name
    (3 for an exact call, 1 for the right result) and the matches already settled, so none counts
    twice. The match being played (sides, calls, the room's goals) is kept there too, so a restart
    at half time loses nothing. Read fresh each time: the control page can start a new season."""

    def __init__(self, data_dir):
        self.path = os.path.join(data_dir, "colours.json")
        self.lock = threading.Lock()

    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return {"table": data.get("table") or {}, "settled": data.get("settled") or [], "match": data.get("match")}
        except (OSError, ValueError):
            pass
        return {"table": {}, "settled": [], "match": None}

    def _save(self, data):
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def table(self):
        """[{name, points, exact, played}] best first (points, then exact calls)."""
        with self.lock:
            rows = [{"name": n, **{k: int(v.get(k, 0)) for k in ("points", "exact", "played")}}
                    for n, v in self._load()["table"].items() if isinstance(v, dict)]
        return sorted(rows, key=lambda r: (-r["points"], -r["exact"], r["name"]))

    def settle(self, match_id, rows):
        """Adds one match's calls ([{name, points}]) to the table, once. Returns whether it did."""
        with self.lock:
            data = self._load()
            if match_id in data["settled"]:
                return False
            for r in rows:
                t = data["table"].setdefault(r["name"], {"points": 0, "exact": 0, "played": 0})
                t["points"] += r["points"]
                t["exact"] += 1 if r["points"] == 3 else 0
                t["played"] += 1
            data["settled"] = (data["settled"] + [match_id])[-300:]
            self._save(data)
            return True

    def reset(self):
        with self.lock:
            data = self._load()
            data["table"] = {}
            self._save(data)

    def match(self, match_id):
        with self.lock:
            m = self._load()["match"]
        return m if isinstance(m, dict) and m.get("id") == match_id else None

    def keep(self, record):
        with self.lock:
            data = self._load()
            data["match"] = record
            self._save(data)


class Colours(PartyGame):
    """Sports nights: the wall takes sides. The host pins tonight's match (ESPN gives the teams,
    their colours, the kickoff and the full-time result) and the wall splits into the two clubs'
    colours: home on top, away below, each with its supporters' names, split by a gold rule.
    Before kickoff everyone can call the score. Goals come only from the room (whoever sees one
    taps GOAL), so a delayed stream is never spoiled; then the scorers tap to push the rule to the
    far edge while the other side taps SAVE, and if it gets there their colour floods the wall.
    At full time the result settles the calls into a season table, and the worst call pours."""
    key = "colours"
    title = "Colours"
    PUSH = 20        # seconds of tap war after a goal
    FLOOD = 10       # seconds the scorers have the whole wall
    TAPS = 40        # taps a side needs, per person tapping, to push the rule to the edge with nobody saving
    SAVE = 0.6       # a SAVE is worth this much of a TAP
    SAME_GOAL = 45   # GOAL taps for the same club this close together are the same goal
    UNDO = 300       # a goal can be taken back (disallowed) for this long
    SETTLE_AFTER = 480  # nobody tapped full time: settle this long after ESPN says it's over
    GIVE_UP = 1200   # full time tapped but ESPN never confirmed: the room's score stands
    HOLD, CARD = 12, 20  # after full time the wall takes turns: the result, then the table
    NOTE = 5         # seconds "NO GOAL" shows on the wall

    def __init__(self, hub, rand=None):
        super().__init__(hub, rand)
        self.season = Season(hub.store.data_dir)
        self.pin_id = None
        self.load_pin()

    def conf(self):
        return self.hub.store.state["channels"]["colours"]

    # -- the pinned match

    def load_pin(self):
        pin = self.conf().get("pin") or None
        self.pin_id = pin["id"] if pin else None
        self.match, self.real = (json.loads(json.dumps(pin)) if pin else None), None
        self.sides, self.calls, self.goals, self.names = {}, {}, [], {}
        self.push, self.result, self.note = None, None, None
        self.next_fetch, self.post_seen, self.ft_at = 0, None, None
        if not pin:
            return self.go("lobby")
        self.fields = club_colours(pin["home"], pin["away"])
        kept = self.season.match(self.pin_id)
        if kept:
            self.sides = {k: v for k, v in kept.get("sides", {}).items() if v in ("home", "away", "neutral")}
            self.calls = {k: v for k, v in kept.get("calls", {}).items() if isinstance(v, dict)}
            self.goals = [g for g in kept.get("goals", []) if isinstance(g, dict)]
            self.names = kept.get("names", {})
            self.result = kept.get("result")
        if self.result:
            self.go("fulltime", self.HOLD)
        elif self.now() < self.kickoff() and pin.get("state", "pre") == "pre":
            self.go("pre")
        else:
            self.go("live")

    def postponed(self):
        return self.match.get("state") == "post" and not self.match.get("completed")

    def kickoff(self):
        try:
            return datetime.datetime.fromisoformat((self.match.get("date") or "").replace("Z", "+00:00")).timestamp()
        except ValueError:
            return 0

    def keep(self):
        for pid in list(self.sides) + list(self.calls):
            self.names[pid] = self.who(pid)["name"]
        self.season.keep({"id": self.pin_id, "sides": self.sides, "calls": self.calls, "goals": self.goals,
                          "names": self.names, "result": self.result})

    def wants(self, now):
        """What GameHub.poll should ask ESPN for: (league, id, date) while the result is to come."""
        if not self.match or self.result or now < self.next_fetch:
            return None
        self.next_fetch = now + 30  # until this one comes back
        return self.match["league"], self.pin_id, self.match.get("date")

    def fetched(self, ask, got):
        if ask[1] != self.pin_id:
            return
        now = self.now()
        if not isinstance(got, dict):  # ESPN is down, or the match has gone from its list
            self.next_fetch = now + 30
            return
        before = (self.match.get("date"), self.match.get("state"), self.match.get("detail"))
        self.match.update({k: got[k] for k in ("date", "state", "completed", "detail") if k in got})
        try:
            self.real = (int(got["home"]["score"]), int(got["away"]["score"]))
        except (KeyError, ValueError, TypeError):
            self.real = None
        if self.match.get("completed") and self.real is not None and self.post_seen is None:
            self.post_seen = now
        if self.phase == "ftwait" and self.post_seen is not None:
            return self.settle("espn")
        gap = 120 if self.phase == "pre" else 20 if self.phase == "ftwait" else 60
        if self.phase == "pre":
            gap = max(10, min(gap, self.kickoff() - now))
        self.next_fetch = now + gap
        if before != (self.match.get("date"), self.match.get("state"), self.match.get("detail")):
            self.changed()

    # -- the clock

    def tick(self):
        if ((self.conf().get("pin") or {}).get("id")) != self.pin_id:
            self.load_pin()
        now = self.now()
        if self.note and now >= self.note[1]:
            self.note = None
            self.changed()
        if self.match and not self.result:
            if self.phase == "pre" and not self.postponed() and (now >= self.kickoff() or self.match.get("state", "pre") == "in"):
                self.go("live")
            elif self.phase == "live" and self.post_seen is not None and now - self.post_seen >= self.SETTLE_AFTER:
                self.settle("espn")
            elif self.phase == "ftwait" and now - self.ft_at >= self.GIVE_UP:
                self.settle("room")
        sig = (self.conf().get("forfeit"), self.conf().get("push"))
        if sig != getattr(self, "sig", sig):
            self.changed()
        self.sig = sig
        if self.push and self.push["dirty"]:
            self.push["dirty"] = False
            self.changed()
        super().tick()

    def on_timeout(self):
        if self.phase in ("push", "flood"):
            self.push = None
            self.go("live")
        elif self.phase == "fulltime":
            self.go("table", self.CARD)
        elif self.phase == "table":
            self.go("fulltime", self.HOLD)

    def start(self):
        pass  # no Start button: pinning a match starts it

    # -- the match

    def score(self):
        if self.result:
            return {"home": self.result["home"], "away": self.result["away"]}
        return {s: sum(1 for g in self.goals if g["side"] == s) for s in ("home", "away")}

    def supporters(self, side):
        return [pid for pid, _ in self.players() if self.sides.get(pid) == side]

    def goal(self, pid, side):
        now = self.now()
        last = next((g for g in reversed(self.goals) if g["side"] == side), None)
        if last and now - last["at"] < self.SAME_GOAL:
            self.notices[pid] = {"title": "GOT IT", "text": "That goal's already on the wall.", "at": now, "plain": True}  # not a sip
            return self.changed()
        self.goals.append({"side": side, "at": now})
        self.keep()
        self.note = None
        if self.conf().get("push", True) and self.supporters(side):
            self.push = {"side": side, "p": 0.0, "dirty": False, "tappers": {}}
            self.go("push", self.PUSH, scorer=side)
        else:
            self.push = None
            self.go("flood", self.FLOOD, scorer=side)

    def undo(self):
        if not self.goals or self.now() - self.goals[-1]["at"] > self.UNDO:
            return
        self.goals.pop()
        self.keep()
        self.push = None
        self.note = ("NO GOAL", self.now() + self.NOTE)
        self.go("live")

    def tap(self, pid, n):
        side, other = self.push["side"], "away" if self.push["side"] == "home" else "home"
        mine = self.sides.get(pid)
        if mine not in (side, other):
            return
        # each side's taps are shared out over the people tapping, so a side with one quiet fan
        # isn't weaker, and three thumbs against one is still a fair fight
        tappers = self.push["tappers"].setdefault(mine, set())
        tappers.add(pid)
        worth = n / (self.TAPS * len(tappers))
        self.push["p"] += worth if mine == side else -self.SAVE * worth
        self.push["p"] = max(0.0, min(1.0, self.push["p"]))
        self.push["dirty"] = True
        if self.push["p"] >= 1:
            self.push["dirty"] = False
            self.go("flood", self.FLOOD, scorer=side, pushed=True)

    def settle(self, source):
        home, away = self.real if source == "espn" and self.real is not None else (self.score()["home"], self.score()["away"])
        rows = []
        for pid, c in self.calls.items():
            if c.get("locked") or c.get("touched"):
                call = (c["home"], c["away"])
                rows.append({"name": self.names.get(pid) or self.who(pid)["name"], "side": self.sides.get(pid, "neutral"),
                             "call": f"{call[0]}-{call[1]}", "points": call_points(call, home, away),
                             "off": abs(call[0] - home) + abs(call[1] - away)})
        rows.sort(key=lambda r: (-r["points"], r["off"], r["name"]))
        self.season.settle(self.pin_id, rows)
        best = [r["name"] for r in rows if r["points"] == 3] or [r["name"] for r in rows if r["points"] == 1]
        self.result = {"home": home, "away": away, "source": source, "winner": "home" if home > away else "away" if away > home else None,
                       "rows": rows, "called": best, "exact": bool(rows) and rows[0]["points"] == 3, "losers": worst_calls(rows)}
        self.push = None
        self.keep()
        self.go("fulltime", self.HOLD)

    # -- input

    def on_input(self, pid, msg):
        kind, ph = msg["kind"], self.phase
        if not self.match or self.result:
            return
        if kind == "pick" and msg.get("id") in ("home", "away", "neutral"):
            if ph == "pre" or pid not in self.sides:
                self.sides[pid] = msg["id"]
                self.keep()
                self.changed()
        elif kind == "pick" and msg.get("id") == "switch" and ph == "pre":
            self.sides.pop(pid, None)
            self.keep()
            self.changed()
        elif kind == "call" and ph == "pre":
            c = self.calls.get(pid) or {}
            if c.get("locked"):
                return
            self.calls[pid] = {"home": msg["home"], "away": msg["away"], "touched": True, "locked": msg["lock"]}
            if msg["lock"] or not c:
                self.keep()
                self.changed()
        elif kind == "goal" and ph == "live":
            self.goal(pid, msg["side"])
        elif kind == "undo" and ph in ("live", "push", "flood"):
            self.undo()
        elif kind == "tap" and ph == "push":
            self.tap(pid, msg.get("n", 1))
        elif kind == "fulltime" and ph == "live":
            self.ft_at = self.now()
            if self.post_seen is not None:
                return self.settle("espn")
            self.next_fetch = 0
            self.go("ftwait")
        elif kind == "resume" and ph == "ftwait":
            self.go("live")

    # -- views

    def team(self, side, wall=True):
        t = self.match[side]
        c = self.fields[0 if side == "home" else 1]
        c = dim(c) if wall else c
        return {"abbr": t.get("abbr", "?"), "name": (t.get("name") or t.get("abbr") or "").upper(), "color": c, "ink": ink(c)}

    def rule(self):
        """Where the gold rule is, from the top (0) to the bottom (1) of the wall."""
        if self.phase == "flood":
            return 1.0 if self.data.get("scorer") == "home" else 0.0
        if self.phase == "push" and self.push:
            return 0.5 + (0.5 if self.push["side"] == "home" else -0.5) * self.push["p"]
        if self.phase in ("fulltime",) and self.result and self.result["winner"]:
            return 1.0 if self.result["winner"] == "home" else 0.0
        return 0.5

    def wall(self):
        view = super().wall()
        if not self.match:
            view["lines"] = ["THE WALL TAKES SIDES", "PICK YOURS ON YOUR PHONE"]
            view["note"] = "THE HOST PINS TONIGHT'S MATCH"
            return view
        here = self.players()
        view["match"] = {"id": self.pin_id, "kickoff": self.kickoff(), "league": self.match.get("leagueName", ""),
                         "home": self.team("home"), "away": self.team("away"),
                         "status": (self.match.get("detail") or "POSTPONED").upper() if self.postponed() else ""}
        view["sides"] = {s: [p["name"] for pid, p in here if self.sides.get(pid) == s] for s in ("home", "away", "neutral")}
        view["score"] = self.score()
        view["rule"] = self.rule()
        view["pushOn"] = bool(self.conf().get("push", True))
        if self.note:
            view["note"] = self.note[0]
        if self.phase == "pre":
            # who has called it (never what they called, until full time)
            view["called"] = [p["name"] for pid, p in here if (self.calls.get(pid) or {}).get("locked")]
        if self.result:
            view["result"] = {k: self.result[k] for k in ("home", "away", "winner", "called", "exact", "losers", "source")}
            view["result"]["calls"] = [{k: r[k] for k in ("name", "call", "points")} for r in self.result["rows"]]
            view["table"] = self.season.table()[:6]
            view["forfeit"] = self.conf().get("forfeit") or "LOSER POURS"
        return view

    def pad(self, pid):
        ph, side = self.phase, self.sides.get(pid)
        if not self.match:
            return self.base_pad(pid, {"ui": "wait", "big": "Colours", "text": "The host pins tonight's match on the control page, then you pick a side."})
        home, away = self.team("home", False), self.team("away", False)
        names = {"home": home["name"].title(), "away": away["name"].title(), "neutral": "Neutral"}
        if self.result:
            r = self.result
            mine = next((row for row in r["rows"] if row["name"] == self.who(pid)["name"]), None)
            table = self.season.table()
            place = next((i + 1 for i, row in enumerate(table) if row["name"] == self.who(pid)["name"]), None)
            final = f"{home['abbr']} {r['home']}-{r['away']} {away['abbr']}"
            if mine:
                big = "Exact" if mine["points"] == 3 else "Right result" if mine["points"] == 1 else "Wrong call"
                text = f"{final}. You called {mine['call']}: " + (f"+{mine['points']}." if mine["points"] else "no points.") + (f" {ordinal(place)} in the season." if place else "")
            else:
                big, text = "Full time", final + "."
            if self.who(pid)["name"] in r["losers"]:
                text += f" {(self.conf().get('forfeit') or 'LOSER POURS').capitalize()}."
            return self.base_pad(pid, {"ui": "result", "key": f"result:{self.pin_id}", "big": big, "text": text,
                                       "tone": "win" if mine and mine["points"] == 3 else "good" if mine and mine["points"] else "plain"})
        if side is None:
            return self.base_pad(pid, {"ui": "pick", "key": f"side:{self.pin_id}", "cols": 1, "title": "Whose side are you on?",
                                       "options": [{"id": "home", "label": home["name"], "color": home["color"]},
                                                   {"id": "away", "label": away["name"], "color": away["color"]},
                                                   {"id": "neutral", "label": "Neutral"}]})
        title = f"{names[side]}" if side != "neutral" else "Neutral"
        if ph == "pre":
            c = self.calls.get(pid) or {}
            return self.base_pad(pid, {"ui": "call", "key": f"call:{self.pin_id}", "home": home, "away": away, "deadline": self.kickoff(),
                                       "value": [c["home"], c["away"]] if c else None, "locked": bool(c.get("locked")),
                                       "title": f"{title} · call the score"})
        if ph == "live":
            last = self.goals[-1] if self.goals else None
            undo = bool(last) and self.now() - last["at"] < self.UNDO
            return self.base_pad(pid, {"ui": "goal", "home": home, "away": away, "score": self.score(), "title": title,
                                       "undo": self.team(last["side"], False)["abbr"] if undo else None,
                                       "until": last["at"] + self.UNDO if undo else None})
        if ph == "push":
            scorer = self.push["side"]
            if side == scorer:
                t = home if side == "home" else away
                return self.base_pad(pid, {"ui": "mash", "label": "TAP", "text": "Push the line to their edge.", "color": t["color"], "ink": t["ink"],
                                           "deadline": self.until, "title": "Goal!"})
            if side != "neutral":
                t = home if side == "home" else away
                return self.base_pad(pid, {"ui": "mash", "label": "SAVE", "text": "Hold the line.", "color": t["color"], "ink": t["ink"],
                                           "deadline": self.until, "title": f"{names[scorer]} scored"})
            return self.base_pad(pid, {"ui": "wait", "big": "Goal", "text": f"{names[scorer]} scored. Eyes on the wall."})
        if ph == "flood":
            scorer = self.data.get("scorer")
            return self.base_pad(pid, {"ui": "wait", "big": "Goal", "text": f"{names[scorer]} take the wall." if side == scorer else f"{names[scorer]} scored."})
        if ph == "ftwait":
            return self.base_pad(pid, {"ui": "next", "big": "Full time", "text": "Getting the final score.",
                                       "buttons": [{"kind": "resume", "label": "Not over yet"}]})
        return super().pad(pid)


PARTY_GAMES = {"closest": ClosestWins, "colours": Colours}
