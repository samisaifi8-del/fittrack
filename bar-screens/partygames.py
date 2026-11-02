"""Party games the Pi referees: the shared game kit, Closest Wins, Five Clues, Five Lights, The Verdict
and Colours.

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
#   suggest {text}           a guest's own prompt (The Verdict: the host approves it first)
#   tap {n?}                 n taps since the last send (a mash pad batches them)
#   call {home, away, lock}  a score call (Colours)    goal {side: home/away}   the room saw a goal
#   undo                     take the last goal back   fulltime, resume   the final whistle, or not yet
INPUTS = ("move", "dir", "tap", "start", "buzz", "next", "end", "pick", "number", "lock", "yesno", "toggle", "pour",
          "suggest", "call", "goal", "undo", "fulltime", "resume")

# The pads play.html can show, by a pad view's "ui". Every pad view also has "key" (the pad is
# rebuilt when it changes), and may have "title" (small gold line), "deadline" (server time the
# countdown bar runs to), "notice" ({title, text}: a sip), "pour" ({options: [{slot, name}]}),
# "lights" ({lit, of}: a row of bulbs, Five Lights),
# "suggest" ({label, hint, max}: a box under the pad for writing your own prompt).
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
#   mash    {label, text, color, ink}           one huge button to tap as fast as you can (sends tap {n})
#   call    {home, away, value, locked}         Colours: +/- per club and LOCK (teams are {abbr, name, color, ink})
#   goal    {home, away, score, undo}           Colours: a GOAL button per club, full time, and "no goal"
PADS = ("wait", "start", "number", "pick", "buzz", "yesno", "toggle", "result", "next", "mash", "call", "goal")

DROP_FOR = 15  # seconds a sip's gold drop stays by a name on the wall


# ---------------------------------------------------------------- decks

_decks = {}


def load_deck(name, folder=CONTENT):
    """The items of static/content/<name>.json: a JSON list of objects, each with a unique "id"
    (or an object whose values are such lists, which are joined, each item marked with its list's
    name as "section"). Re-read when the file changes; a missing or broken deck is an empty one, so
    a bad edit can't stop the server."""
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
        data = [{"section": k, **i} if isinstance(i, dict) else i for k, v in data.items() if isinstance(v, list) for i in v]
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

    def host(self):
        """What the host's control page shows for this game (None: nothing)."""
        return None

    def host_action(self, body):
        """An action from the host's control page (POST /api/game/host). Returns a message for the
        host when it can't be done; raises ValueError for an unknown one."""
        raise ValueError


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


# Closest Wins: a question may carry a fact that comes up with its answer (the wall swaps the
# question for it once the answer has landed, and phones show it under the result).
FACT_MAX = 110   # characters: three short lines at the top of the wall
FACT_READ = 3.5  # seconds added to the reveal to read it


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
        fact = str(it.get("fact") or "")[:FACT_MAX]
        if fact:
            times["end"] = round(times["end"] + FACT_READ, 2)  # time to read the fact once the winner's shown
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
                spot=bool(rows) and rows[-1]["off"] == 0, winner=winner, times=times, fact=fact,
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
            fact = self.data.get("fact")
            return self.base_pad(pid, {"ui": "result", "key": f"reveal:{self.at}", "big": ordinal(r["rank"]),
                                       "text": f"{off} · {pts}" + (" (doubled)" if r["doubled"] else ""), "fact": fact or "",
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
            tier = msg["id"]
            self.hub.after(lambda: self.hub.store.update_channels({"games": {"tier": tier}}))
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


# ---------------------------------------------------------------- the verdict

PROMPT_MAX = 32  # a prompt longer than this can't be set huge on a 256-wide wall
LEAD = re.compile(r"^(WHO(?:'S|\u2019S| IS)?\s+)?(?:THE\s+)?MOST\s+LIKELY\s+TO\s+")


def clean_prompt(text):
    """A guest's prompt as the wall sets it: capitals, single spaces, without the "WHO'S MOST
    LIKELY TO" in front (the wall says that) or a question mark after. None if it's too short or
    too long to set huge."""
    text = LEAD.sub("", " ".join(str(text or "").split()).upper()).rstrip(" ?.!")
    return text if 3 <= len(text) <= PROMPT_MAX and re.search(r"[A-Z]", text) else None


def tally(votes):
    """The Verdict's count. votes: {voter: slot}. Returns ({slot: votes}, [top slots]): one top
    slot is GUILTY, more than one is a HUNG JURY, none is nobody voting."""
    counts = {}
    for slot in votes.values():
        counts[slot] = counts.get(slot, 0) + 1
    top = max(counts.values(), default=0)
    return counts, sorted(s for s, n in counts.items() if n == top and top)


def rise_beat(top):
    """Seconds per vote while the bars rise: a slow count, but never more than about 5 s in all."""
    return round(min(0.8, 4.8 / max(1, top)), 3)


class Verdict(PartyGame):
    """A prompt about the people in the room goes up ("WHO'S MOST LIKELY TO LOSE THEIR PHONE
    TONIGHT"), everyone votes in secret on their phone for someone who's here (never themselves),
    and the wall reads out the verdict like a jury: the names rise as gold bars, a vote at a time,
    then the top name is GUILTY (or it's a HUNG JURY on a tie). The host picks the deck (Pre-party
    or Game night) and the pace (a new prompt every 2 minutes, or by hand); guests can write their
    own prompts, which only go up once the host approves them on the control page. The convicted
    get a sip if they're drinking; between prompts a quiet card shows the night's most convicted."""
    key = "verdict"
    title = "The Verdict"
    DECK = "verdict"
    DECKS = {"preparty": "Pre-party", "gamenight": "Game night"}
    LEAD = "WHO'S MOST LIKELY TO"
    VOTE = 30
    VERDICT = 9
    PACE = 120         # auto pace: a new prompt this many seconds after the last one went up
    CARD_MIN = 8       # the card between prompts stays up at least this long
    MIN_PLAYERS = 3    # with two, each can only vote for the other: always a hung jury
    BARS = 6           # the most names that rise on the wall (the ones with the most votes)
    WAITING_MAX = 20   # guests' prompts waiting for the host
    PER_PHONE = 3      # of those, from any one phone

    def __init__(self, hub, rand=None):
        super().__init__(hub, rand)
        self.prompt = None   # {"id", "text", "guest"?}
        self.votes = {}      # voter pid -> the slot they voted for
        self.count = 0       # prompts tonight
        self.started = 0.0   # when the current prompt went up (the auto pace counts from here)
        self.result = None   # the last verdict: {"slots", "votes", "names", "guilty"}
        self.waiting = []    # guests' prompts for the host to approve: {"id", "text", "by", "pid"}
        self.approved = []   # approved ones, played before the deck
        self.go("lobby")

    # -- the host's settings (control page, Channel settings)

    def deck(self):
        d = self.hub.store.state["channels"]["games"].get("verdictDeck")
        return d if d in self.DECKS else "preparty"

    def hand_paced(self):
        return self.hub.store.state["channels"]["games"].get("verdictPace") == "hand"

    def card_until(self):
        return None if self.hand_paced() else max(self.started + self.PACE, self.at + self.CARD_MIN)

    # -- the flow

    def start(self):
        if len(self.players()) < self.MIN_PLAYERS:
            return self.changed()
        self.night, self.count, self.result = {}, 0, None
        self.next_prompt()

    def draw(self):
        if self.approved:
            return self.approved.pop(0)
        deck = self.deck()
        pool = [i for i in load_deck(self.DECK) if i.get("section") == deck and isinstance(i.get("text"), str)]
        got = self.hub.used.draw(f"{self.DECK}:{deck}", pool, 1, self.rand) if pool else []
        return got[0] if got else None

    def next_prompt(self):
        if len(self.players()) < self.MIN_PLAYERS:
            return self.go("lobby")
        self.prompt = self.draw()
        if not self.prompt:
            return self.go("lobby", note="The prompt deck is missing.")
        self.votes, self.result = {}, None
        self.count += 1
        self.started = self.now()
        self.go("vote", self.VOTE, text=self.prompt["text"], lead=self.LEAD, guest=bool(self.prompt.get("guest")), n=self.count)

    def reveal(self):
        here = {p["slot"]: (pid, p) for pid, p in self.players()}
        votes = {v: slot for v, slot in self.votes.items() if v in {pid for pid, _ in here.values()} and slot in here}
        counts, top = tally(votes)
        if not counts:
            self.result = {"slots": [], "votes": 0, "names": [], "guilty": False}
            return self.go("verdict", self.VERDICT / 2, text=self.prompt["text"], lead=self.LEAD, n=self.count, **self.result)
        shown = sorted(sorted(counts, key=lambda s: (-counts[s], s))[:self.BARS])
        most = counts[top[0]]
        beat = rise_beat(most)
        self.result = {"slots": top, "votes": most, "names": [here[s][1]["name"] for s in top], "guilty": len(top) == 1}
        self.go("reveal", beat * most + 1.6, text=self.prompt["text"], lead=self.LEAD, n=self.count, beat=beat, top=most,
                bars=[{"slot": s, "name": here[s][1]["name"], "color": here[s][1]["color"], "votes": counts[s]} for s in shown])

    def verdict(self):
        r = self.result
        if r["guilty"]:
            pid = next((q for q, p in self.players() if p["slot"] == r["slots"][0]), None)
            if pid:
                self.night[pid] = self.night.get(pid, 0) + 1
                self.award_sip(pid, "Guilty as charged: a sip. Any drink or water counts.", title="GUILTY")
        self.go("verdict", self.VERDICT, text=self.prompt["text"], lead=self.LEAD, n=self.count, **r)

    def card(self):
        rows = self.standings(self.night)
        top = [r for r in rows if r["place"] == 1 and r["points"] > 0]
        most = {"names": [r["name"] for r in top], "count": top[0]["points"]} if top else None
        self.go("card", None, most=most, n=self.count, hand=self.hand_paced())
        self.until = self.card_until()

    def tick(self):
        # the host can change the pace while the card is up
        if self.phase == "card" and self.until != self.card_until():
            self.until = self.card_until()
            self.data["hand"] = self.hand_paced()
            self.changed()
        super().tick()

    def on_timeout(self):
        if self.phase == "vote":
            self.reveal()
        elif self.phase == "reveal":
            self.verdict()
        elif self.phase == "verdict":
            self.card()
        elif self.phase == "card":
            self.next_prompt()

    def on_input(self, pid, msg):
        kind = msg["kind"]
        if kind == "suggest":
            return self.suggest(pid, msg["text"])
        if self.phase == "vote" and kind == "pick":
            try:
                slot = int(msg.get("id", ""))
            except ValueError:
                return
            here = self.players()
            me = self.hub.players[pid]["slot"]
            if slot == me or slot not in {p["slot"] for _, p in here}:
                return
            self.votes[pid] = slot
            self.changed()
            if all(q in self.votes for q, _ in here):
                self.until = min(self.until or 1e18, self.now() + 1.5)
        elif self.phase == "card" and kind == "next" and self.hand_paced():
            self.next_prompt()
        elif self.phase == "card" and kind == "end":
            self.go("lobby")

    # -- guests' prompts, and the host

    def suggest(self, pid, text):
        clean = clean_prompt(text)
        mine = sum(1 for w in self.waiting if w["pid"] == pid)
        if not clean:
            note = {"title": "TRY AGAIN", "text": f"Keep it short, up to {PROMPT_MAX} letters: LOSE THEIR PHONE TONIGHT."}
        elif mine >= self.PER_PHONE or len(self.waiting) >= self.WAITING_MAX:
            note = {"title": "PLENTY WAITING", "text": "The host has a few to look at. Send another once those go up."}
        elif any(w["text"] == clean for w in self.waiting + self.approved):
            note = {"title": "ALREADY IN", "text": "That one's waiting already."}
        else:
            uid = hashlib.sha1(f"{clean}|{pid}|{self.now()}".encode()).hexdigest()[:10]
            self.waiting.append({"id": uid, "text": clean, "by": self.who(pid)["name"], "pid": pid})
            note = {"title": "SENT TO THE HOST", "text": "If they approve it, it goes up soon."}
            self.hub.after(self.hub.store.refresh)
        self.notices[pid] = {**note, "at": self.now()}
        self.changed()

    def host(self):
        return {"game": self.key, "phase": self.phase, "deck": self.deck(), "pace": "hand" if self.hand_paced() else "auto",
                "waiting": [{"id": w["id"], "text": w["text"], "by": w["by"]} for w in list(self.waiting)],
                "approved": [a["text"] for a in list(self.approved)]}

    def host_action(self, body):
        """approve / bin a guest's prompt (by id), or next: the next prompt now (during a vote,
        that skips the one on the wall)."""
        action = body.get("action")
        if action in ("approve", "bin"):
            w = next((w for w in self.waiting if w["id"] == body.get("id")), None)
            if not w:
                return
            self.waiting.remove(w)
            if action == "approve":
                self.approved.append({"id": "g-" + w["id"], "text": w["text"], "guest": True})
                self.notices[w["pid"]] = {"title": "APPROVED", "text": "The host liked yours. It goes up soon.", "at": self.now()}
            self.changed()
        elif action == "next":
            if len(self.players()) < self.MIN_PLAYERS:
                return f"The Verdict needs {self.MIN_PLAYERS} players: join on your phones at /play."
            if self.phase == "lobby":
                self.start()
            else:
                self.next_prompt()
        else:
            raise ValueError
        self.hub.after(self.hub.store.refresh)

    # -- views

    def wall(self):
        view = super().wall()
        here = self.players()
        if self.phase == "vote":
            view["in"] = sum(1 for q, _ in here if q in self.votes)
            view["of"] = len(here)
        if self.phase == "lobby":
            view["lines"] = ["A QUESTION ABOUT THE ROOM", "VOTE IN SECRET", "THE WALL READS THE VERDICT"]
            short = self.MIN_PLAYERS - len(here)
            if short > 0 and not self.data.get("note"):
                view["note"] = "NEEDS ONE MORE PLAYER" if short == 1 else f"NEEDS {self.MIN_PLAYERS} PLAYERS"
        return view

    def suggest_box(self, pid):
        mine = sum(1 for w in self.waiting if w["pid"] == pid)
        return {"label": "Write your own", "hint": "LOSE THEIR PHONE TONIGHT", "max": PROMPT_MAX,
                "text": f"{mine} waiting for the host." if mine else "Finish the line: who's most likely to… The host approves it before it goes up."}

    def pad(self, pid):
        ph = self.phase
        here = self.players()
        me = self.hub.players.get(pid, {}).get("slot")
        voted = self.votes.get(pid)
        name_of = {p["slot"]: p["name"] for _, p in here}
        you_voted = f"You voted {name_of[voted].title()}." if voted in name_of else "No vote from you this time."
        view = None
        if ph == "lobby":
            short = self.MIN_PLAYERS - len(here)
            view = {"ui": "start", "big": "The Verdict", "label": "Start",
                    "text": "A question about the room goes up on the wall. Vote in secret for whoever fits it best, then the wall reads out the verdict."
                            + (f" Needs {self.MIN_PLAYERS} players." if short > 0 else "")}
        elif ph == "vote":
            options = [{"id": str(p["slot"]), "label": p["name"], "color": p["color"]} for _, p in here if p["slot"] != me]
            view = {"ui": "pick", "key": f"vote:{self.at}:{','.join(o['id'] for o in options)}", "options": options, "cols": 2,
                    "chosen": str(voted) if voted is not None else None, "deadline": self.until,
                    "title": "Your vote · secret"}
            return self.base_pad(pid, view)
        elif ph == "reveal":
            view = {"ui": "wait", "big": "Eyes on the wall", "text": you_voted}
        elif ph == "verdict":
            r = self.result or {}
            if not r.get("slots"):
                view = {"ui": "result", "big": "No verdict", "text": "Nobody voted. Get the next one in.", "tone": "plain"}
            elif r["guilty"] and r["slots"][0] == me:
                view = {"ui": "result", "big": "Guilty", "tone": "win",
                        "text": f"{r['votes']} vote{'s' if r['votes'] != 1 else ''}. The room has spoken."}
            elif r["guilty"]:
                view = {"ui": "result", "big": r["names"][0].title(), "text": f"Guilty. {you_voted}", "tone": "plain"}
            else:
                view = {"ui": "result", "big": "Hung jury", "tone": "plain",
                        "text": f"{' & '.join(n.title() for n in r['names'])} tied. {you_voted}"}
        elif ph == "card":
            if self.hand_paced():
                view = {"ui": "next", "big": "The Verdict", "text": "Ready for the next one?",
                        "buttons": [{"kind": "next", "label": "Next verdict"}, {"kind": "end", "label": "Finish"}]}
            else:
                view = {"ui": "wait", "big": "Next verdict", "deadline": self.until,
                        "text": "It goes up by itself. Write one of your own while you wait."}
        if view is None:
            return super().pad(pid)
        view["suggest"] = self.suggest_box(pid)
        return self.base_pad(pid, view)


# ---------------------------------------------------------------- colours

GOLD = "#b89a63"
GOLD_LIGHT = "#d9c49a"
IVORY = "#ece4d4"
HOUSE_IVORY = "#c4beb2"  # ivory for a whole field: a little lower, so it reads as ivory, not white
DIM = 0.6          # a club's colour at 60%, so a big field of it doesn't glare in a dim room
NEAR_BLACK = 0.008  # a dimmed colour darker than this (relative luminance) looks like the wall is off
CLASH = 70         # two dimmed colours closer than this (RGB distance) look like the same colour
INK_DARK = 0.2     # on a field brighter than this, type is black instead of ivory
PALE = (0.7, 0.4)  # a club colour at least this bright and at most this saturated is white or a pale tint
SHORT_MAX = 6      # ESPN's short name (SPURS, BAYERN) is the club's label on the wall up to this long


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


def pale(c):
    """White or a pale tint (Spurs, Fulham, Man City's sky blue): dimmed, it would be a big flat grey,
    so on the wall that club's half is black, with its colour as the type."""
    hi, lo = max(_rgb(c)), min(_rgb(c))
    return c != HOUSE_IVORY and hi >= PALE[0] * 255 and (hi - lo) / hi <= PALE[1]


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)))
    return (lb + 0.05) / (la + 0.05)


def club_label(t):
    """A club's name in tight spots on the wall: ESPN's short name when it's short (SPURS, BETIS,
    MÁLAGA), else its abbreviation. ESPN's abbreviations can mislead (Bayern's is MUN)."""
    name = (t.get("name") or "").upper()
    return name if name and len(name) <= SHORT_MAX else (t.get("abbr") or name[:4] or "?")


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
        c, other = self.fields[:2] if side == "home" else self.fields[1::-1]
        view = {"abbr": club_label(t), "name": (t.get("name") or t.get("abbr") or "").upper()}
        if not wall:
            return {**view, "color": c, "ink": ink(c)}
        if pale(c) and not (side == "away" and pale(other)):  # both pale: only the home half goes black
            light = max(_rgb(c)) - min(_rgb(c)) < 30
            return {**view, "color": "#000000", "ink": IVORY if light else dim(c, 0.9), "accent": GOLD_LIGHT}
        c = dim(c)
        # gold type (GOAL, FULL TIME) only where it stands out from the field; else the field's ink
        return {**view, "color": c, "ink": ink(c), "accent": GOLD_LIGHT if contrast(GOLD_LIGHT, c) >= 2.6 else ink(c)}

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


PARTY_GAMES = {"closest": ClosestWins, "fiveclues": FiveClues, "fivelights": FiveLights, "verdict": Verdict,
               "colours": Colours}
