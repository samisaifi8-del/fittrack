#!/usr/bin/env python3
"""Tests for the party-game kit and Closest Wins: decks, used items, years.txt, scoring, the sips
rules and a whole round through the game hub. Standard library only:  python3 test_party.py"""

import json
import os
import queue
import random
import tempfile
import unittest

import partygames
import server


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


def make_hub(tmp, game="closest", sips=False):
    store = server.Store(tmp)
    store.state["channels"]["games"]["game"] = game
    store.state["channels"]["games"]["sipsUntil"] = 2e9 if sips else 0
    hub = server.GameHub.__new__(server.GameHub)
    hub.clock = Clock()
    server.GameHub.__init__(hub, store)
    if hub.party:
        hub.party.rand = random.Random(7)
    return hub


def join(hub, pid, name, drinks=None):
    body = {"pid": pid, "name": name}
    if drinks is not None:
        body["drinks"] = drinks
    return hub.join(body)


def send(hub, pid, kind, **kw):
    hub.input({"pid": pid, "kind": kind, **kw})


def run_for(hub, secs):
    end = hub.clock.t + secs
    while hub.clock.t < end:
        hub.clock.t += 0.25
        hub.tick()


class Decks(unittest.TestCase):
    def test_numbers_deck(self):
        items = partygames.load_deck("numbers")
        self.assertGreaterEqual(len(items), 200)
        for i in items:
            self.assertLessEqual(i["min"], i["answer"], i["id"])
            self.assertLessEqual(i["answer"], i["max"], i["id"])
            self.assertEqual(i["answer"] % (i.get("step") or 1), 0, i["id"])  # the dial can reach it
            self.assertLessEqual(len(i["q"].split()), 10, i["id"])
            self.assertLessEqual(len(i.get("fact") or ""), partygames.FACT_MAX, i["id"])

    def test_bad_names_and_files(self):
        self.assertEqual(partygames.load_deck("../server"), [])
        self.assertEqual(partygames.load_deck("no-such-deck"), [])
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "broken.json"), "w") as f:
                f.write("[{")
            self.assertEqual(partygames.load_deck("broken", tmp), [])
            with open(os.path.join(tmp, "dupes.json"), "w") as f:
                json.dump([{"id": "a"}, {"id": "a"}, {"no": "id"}, 3, {"id": "b"}], f)
            self.assertEqual([i["id"] for i in partygames.load_deck("dupes", tmp)], ["a", "b"])


class Used(unittest.TestCase):
    def test_no_repeats_until_the_pool_runs_out(self):
        with tempfile.TemporaryDirectory() as tmp:
            pool = [{"id": f"q{i}"} for i in range(10)]
            used = partygames.UsedItems(os.path.join(tmp, "used.json"))
            rand = random.Random(1)
            first = used.draw("d", pool, 4, rand) + used.draw("d", pool, 4, rand)
            self.assertEqual(len({i["id"] for i in first}), 8)
            # two left: those two come first, then the pool starts over
            third = used.draw("d", pool, 4, rand)
            left = {f"q{i}" for i in range(10)} - {i["id"] for i in first}
            self.assertTrue(left <= {i["id"] for i in third})
            self.assertEqual(len({i["id"] for i in third}), 4)
            # saved: a new store (a restart) remembers
            again = partygames.UsedItems(os.path.join(tmp, "used.json"))
            self.assertEqual(again.played("d"), used.played("d"))

    def test_pools_are_separate(self):
        with tempfile.TemporaryDirectory() as tmp:
            used = partygames.UsedItems(os.path.join(tmp, "used.json"))
            a = [{"id": "a1"}, {"id": "a2"}]
            b = [{"id": "b1"}, {"id": "b2"}, {"id": "b3"}]
            used.draw("d", b, 2)
            used.draw("d", a, 2)
            used.draw("d", a, 1)  # a starts over; b's played items stay played
            self.assertEqual(len(used.played("d") & {"b1", "b2", "b3"}), 2)


class Years(unittest.TestCase):
    def test_lines(self):
        text = "# my list\nDaft Punk - One More Time - 2000\n\nOutkast – Hey Ya! – 2003\nSuperbad - 2007\n" \
               "Burial - Archangel (2007)\nnot a line\nSomeone - Song - 1875\nFuture - Song - 2099\n"
        items, bad = partygames.parse_years(text, 2026)
        self.assertEqual([(i["by"], i["q"], i["answer"]) for i in items], [
            ("DAFT PUNK", "ONE MORE TIME", 2000), ("OUTKAST", "HEY YA!", 2003), ("", "SUPERBAD", 2007),
            ("BURIAL", "ARCHANGEL", 2007)])
        self.assertEqual(bad, [7, 8, 9])
        self.assertTrue(all(i["min"] <= i["answer"] <= i["max"] == 2026 for i in items))
        self.assertEqual(items[0]["id"], partygames.parse_years("daft punk  -  one more time - 2000")[0][0]["id"])


class Scoring(unittest.TestCase):
    def test_places(self):
        rows = {r["pid"]: r for r in partygames.score_guesses(828, {"a": 800, "b": 900, "c": 1000, "d": 500})}
        self.assertEqual([rows[p]["points"] for p in "abcd"], [3, 2, 1, 0])
        self.assertEqual(partygames.score_guesses(828, {"a": 800, "b": 900})[0]["pid"], "b")  # furthest first

    def test_spot_on_and_ties(self):
        rows = {r["pid"]: r for r in partygames.score_guesses(10, {"a": 10, "b": 12, "c": 8, "d": 20})}
        self.assertEqual(rows["a"]["points"], 5)
        self.assertEqual((rows["b"]["rank"], rows["c"]["rank"]), (2, 2))
        self.assertEqual((rows["b"]["points"], rows["c"]["points"]), (2, 2))
        self.assertEqual(rows["d"]["rank"], 4)

    def test_double(self):
        rows = {r["pid"]: r for r in partygames.score_guesses(50, {"a": 49, "b": 10, "c": 30, "d": 40, "e": 0}, {"a", "e"})}
        self.assertEqual(rows["a"]["points"], 6)
        self.assertEqual(rows["e"]["points"], -2)

    def test_round_points_never_go_below_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            g = make_hub(tmp).party
            g.add_points("x", -2)
            g.add_points("x", 3)
            self.assertEqual((g.points["x"], g.night["x"]), (3, 3))

    def test_format(self):
        self.assertEqual(partygames.fmt(3333360), "3,333,360")
        self.assertEqual(partygames.fmt(1999, year=True), "1999")
        self.assertEqual([partygames.ordinal(n) for n in (1, 2, 3, 4, 11, 12, 21)], ["1st", "2nd", "3rd", "4th", "11th", "12th", "21st"])
        self.assertEqual(partygames.initials(["SAMI", "SARA", "LAYLA"]), ["SA", "SA", "L"])


class Hub(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_inputs_are_checked(self):
        hub = make_hub(self.tmp.name, game="breaker")
        join(hub, "pid-one", "Sami")
        q = hub.subscribe("display", None)
        send(hub, "pid-one", "pick", choice=2)
        send(hub, "pid-one", "number", value=828.4)
        send(hub, "pid-one", "toggle", id="double", on=True)
        msgs = [json.loads(q.get_nowait()) for _ in range(q.qsize())]
        inputs = [m for m in msgs if m["type"] == "input"]
        self.assertEqual([(m["kind"], m.get("choice"), m.get("value"), m.get("on")) for m in inputs],
                         [("pick", 2, None, None), ("number", None, 828.4, None), ("toggle", None, None, True)])
        for bad in [{"kind": "number", "value": "9"}, {"kind": "pick"}, {"kind": "yesno", "yes": 1},
                    {"kind": "pour", "to": "x"}, {"kind": "explode"}]:
            with self.assertRaises(server.ApiError):
                hub.input({"pid": "pid-one", **bad})

    def test_whole_round(self):
        hub = make_hub(self.tmp.name)
        g = hub.party
        self.assertEqual(g.phase, "lobby")
        join(hub, "pid-sami", "Sami")
        join(hub, "pid-layla", "Layla")
        pad_q = hub.subscribe("pad", "pid-sami")
        wall_q = hub.subscribe("display", None)
        send(hub, "pid-sami", "start")
        self.assertEqual((g.phase, g.round), ("card", 1))
        self.assertEqual(len(g.questions), 6)
        cats = {i["category"] for i in partygames.load_deck("numbers") if not (i["unit"] == "YEAR" and i["category"] in g.RELEASE)}
        self.assertEqual(len({i["category"] for i in g.questions}), min(6, len(cats)))  # every kind of fan gets one
        run_for(hub, g.CARD + 0.5)
        for n in range(6):
            if n == 5:
                self.assertEqual(g.phase, "double")
                send(hub, "pid-layla", "toggle", id="double", on=True)
                run_for(hub, g.DOUBLE + 0.5)
            self.assertEqual(g.phase, "ask")
            item = g.item()
            # the phone gets the dial but never the question
            pad = g.pad("pid-sami")
            self.assertEqual(pad["ui"], "number")
            self.assertNotIn(item["q"], json.dumps(pad))
            send(hub, "pid-sami", "lock", value=item["answer"])
            send(hub, "pid-layla", "number", value=item["max"])  # moved but never locked: still counts
            self.assertEqual(g.phase, "ask")
            run_for(hub, g.ASK)
            self.assertEqual(g.phase, "reveal")
            self.assertTrue(g.data["spot"])
            self.assertTrue(g.data["winner"].endswith("SPOT ON"))
            # the question's fact comes with the answer, on the wall and on the phones
            fact = str(item.get("fact") or "")[:partygames.FACT_MAX]
            self.assertEqual(g.data["fact"], fact)
            times = g.data["times"]
            run_for(hub, times["answer"] + 0.5)
            self.assertEqual(g.pad("pid-sami").get("fact", ""), fact)
            run_for(hub, times["end"] - times["answer"])
        self.assertEqual(g.phase, "podium")
        self.assertEqual(g.points["pid-sami"], 30)  # spot on six times
        self.assertEqual(g.data["places"][0]["name"], "SAMI")
        send(hub, "pid-layla", "next")
        self.assertEqual(g.round, 2)
        # messages: the wall's views never mention drinking; phones got their own pads
        walls = [json.loads(m) for m in iter_queue(wall_q) if '"party"' in m]
        pads = [json.loads(m) for m in iter_queue(pad_q) if '"party"' in m]
        self.assertTrue(walls and pads)
        self.assertFalse(any("drinks" in json.dumps(w) for w in walls))
        self.assertTrue(any(p.get("ui") == "result" for p in pads))

    def test_everyone_locked_ends_early(self):
        hub = make_hub(self.tmp.name)
        g = hub.party
        join(hub, "pid-a1", "A")
        join(hub, "pid-b1", "B")
        send(hub, "pid-a1", "start")
        run_for(hub, g.CARD + 0.5)
        send(hub, "pid-a1", "lock", value=1)
        send(hub, "pid-b1", "lock", value=2)
        run_for(hub, 1.5)
        self.assertEqual(g.phase, "reveal")

    def test_every_third_round_is_what_year(self):
        hub = make_hub(self.tmp.name)
        with open(os.path.join(self.tmp.name, "years.txt"), "w") as f:
            f.write("Daft Punk - One More Time - 2000\nOutkast - Hey Ya! - 2003\nBurial - Archangel - 2007\n"
                    "Jay-Z - Encore - 2003\n")
        g = hub.party
        join(hub, "pid-a1", "A")
        g.start()
        g.round = 2
        g.next_round()
        self.assertEqual((g.round, g.data["kind"]), (3, "year"))
        self.assertTrue(all(i["unit"] == "YEAR" for i in g.questions))
        self.assertGreaterEqual(sum(i["category"] == "yours" for i in g.questions), 3)
        run_for(hub, g.CARD + 0.5)
        self.assertEqual(g.data["tag"], "WHAT YEAR?")

    def test_sips(self):
        hub = make_hub(self.tmp.name, sips=True)
        g = hub.party
        join(hub, "pid-near", "Near", drinks=True)
        join(hub, "pid-far1", "Far", drinks=True)
        join(hub, "pid-far2", "Farther", drinks=False)
        send(hub, "pid-near", "start")
        run_for(hub, g.CARD + 0.5)
        ans, lo, hi = g.item()["answer"], g.item()["min"], g.item()["max"]
        far = lo if ans - lo > hi - ans else hi
        send(hub, "pid-near", "lock", value=ans)
        send(hub, "pid-far1", "lock", value=(ans + far) / 2)
        send(hub, "pid-far2", "lock", value=far)
        run_for(hub, 1.5)
        rows = {r["name"]: r for r in g.data["rows"]}
        # the furthest guess isn't drinking, so nobody gets that sip: it doesn't pass to anyone else
        self.assertFalse(any(r["sip"] for r in rows.values()))
        self.assertEqual(g.drops, {})
        # spot on: Near (drinking) may pour one out, but only to another drinker
        run_for(hub, g.data["times"]["line"] + 0.5)
        pad = g.pad("pid-near")
        self.assertEqual([o["name"] for o in pad["pour"]["options"]], ["FAR"])
        send(hub, "pid-near", "pour", to=hub.players["pid-far2"]["slot"])  # not drinking: refused
        self.assertNotIn("pid-far2", g.drops)
        send(hub, "pid-near", "pour", to=hub.players["pid-far1"]["slot"])
        self.assertIn("pid-far1", g.drops)
        self.assertNotIn("pour", g.pad("pid-near"))
        self.assertIn("poured you one", g.pad("pid-far1")["notice"]["text"])
        wall = g.wall()
        self.assertEqual([p["name"] for p in wall["players"] if p["drop"]], ["FAR"])
        self.assertNotIn("drinks", json.dumps(wall))

    def test_furthest_drinker_gets_the_sip(self):
        hub = make_hub(self.tmp.name, sips=True)
        g = hub.party
        join(hub, "pid-a1", "A", drinks=True)
        join(hub, "pid-b1", "B", drinks=True)
        send(hub, "pid-a1", "start")
        run_for(hub, g.CARD + 0.5)
        it = g.item()
        send(hub, "pid-a1", "lock", value=it["answer"])
        send(hub, "pid-b1", "lock", value=it["max"] if it["max"] - it["answer"] > it["answer"] - it["min"] else it["min"])
        run_for(hub, 1.5)
        self.assertTrue(next(r for r in g.data["rows"] if r["name"] == "B")["sip"])
        self.assertNotIn("notice", g.pad("pid-b1"))  # not before the wall shows the answer
        run_for(hub, g.data["times"]["answer"] + 1)
        self.assertEqual(g.pad("pid-b1")["notice"]["title"], "A SIP")

    def test_sips_off(self):
        hub = make_hub(self.tmp.name, sips=False)
        g = hub.party
        join(hub, "pid-a1", "A", drinks=True)
        self.assertFalse(g.award_sip("pid-a1", "test"))
        self.assertEqual(g.drops, {})

    def test_sips_switch_for_the_night(self):
        store = server.Store(self.tmp.name)
        store.update_channels({"games": {"sips": True}})
        until = store.state["channels"]["games"]["sipsUntil"]
        self.assertTrue(0 < until - server.time.time() <= 24 * 3600)
        store.update_channels({"games": {"sips": False}})
        self.assertEqual(store.state["channels"]["games"]["sipsUntil"], 0)


def iter_queue(q):
    while True:
        try:
            yield q.get_nowait()
        except queue.Empty:
            return


if __name__ == "__main__":
    unittest.main()
