#!/usr/bin/env python3
"""Tests for Colours: club colours and their fallbacks, call points and who pours, the season
table, and a whole match through the game hub with a stand-in for ESPN (sides, calls, the room's
goals, the tap war, the flood, full time). Standard library only:  python3 test_colours.py"""

import datetime
import json
import os
import tempfile
import unittest

import partygames
import server
from test_party import Clock, join, run_for, send

KICKOFF = 1_000_000.0 + 600  # ten minutes after the test clock starts


def team(abbr, name, color, alt):
    return {"abbr": abbr, "name": name, "color": color, "alt": alt}


def espn_match(state="pre", completed=False, home=0, away=0, detail="Scheduled"):
    iso = datetime.datetime.fromtimestamp(KICKOFF, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
    return {"id": "401", "league": "eng.1", "leagueName": "Premier League", "date": iso, "state": state,
            "completed": completed, "detail": detail,
            "home": {**team("CHE", "Chelsea", "#144992", "#ffffff"), "score": str(home)},
            "away": {**team("MAN", "Man United", "#da020e", "#4169e1"), "score": str(away)}}


class FakeEspn:
    def __init__(self):
        self.match = espn_match()
        self.asked = 0
        self.down = False

    def __call__(self, league, event_id, date=None):
        self.asked += 1
        if self.down:
            raise IOError("down")
        return json.loads(json.dumps(self.match)) if event_id == "401" else None


def make_hub(tmp, push=True, pinned=True):
    store = server.Store(tmp)
    store.state["channels"]["games"]["game"] = "colours"
    pin = espn_match()
    for side in ("home", "away"):
        pin[side].pop("score")
    store.state["channels"]["colours"].update(pin=pin if pinned else None, push=push)
    hub = server.GameHub.__new__(server.GameHub)
    hub.clock = Clock()
    hub.espn = FakeEspn()
    server.GameHub.__init__(hub, store)
    return hub


def until_kickoff(hub):
    hub.clock.t = KICKOFF + 1
    hub.tick()


class ClubColours(unittest.TestCase):
    def test_espn_colours_darkened(self):
        h, a, how = partygames.club_colours(team("CHE", "", "#144992", "#ffffff"), team("MAN", "", "#da020e", "#4169e1"))
        self.assertEqual((h, a, how), ("#144992", "#da020e", "espn"))
        self.assertEqual(partygames.dim("#da020e"), "#830108")  # 60% of each channel

    def test_labels(self):
        self.assertEqual(partygames.club_label(team("MUN", "Bayern", "#dc052d", None)), "BAYERN")
        self.assertEqual(partygames.club_label(team("MCF", "Málaga", "#b9e6f2", None)), "MÁLAGA")
        self.assertEqual(partygames.club_label(team("NFO", "Nottm Forest", "#c8102e", None)), "NFO")
        self.assertEqual(partygames.club_label(team("?", "", None, None)), "?")

    def test_a_white_club_is_black_on_the_wall(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        g = make_hub(tmp.name).party
        g.fields = ("#ffffff", "#0202fb", "espn")  # Spurs v Palace
        spurs, palace = g.team("home"), g.team("away")
        self.assertEqual((spurs["color"], spurs["ink"], spurs["accent"]), ("#000000", partygames.IVORY, partygames.GOLD_LIGHT))
        self.assertEqual((palace["color"], palace["accent"]), ("#010197", partygames.GOLD_LIGHT))
        self.assertEqual(g.team("home", False)["color"], "#ffffff")  # phones keep the real colour
        g.fields = ("#99c5ea", "#ffffff", "espn")  # both pale: only the home half goes black
        self.assertEqual((g.team("home")["color"], g.team("home")["ink"]), ("#000000", partygames.dim("#99c5ea", 0.9)))
        self.assertEqual(g.team("away")["color"], "#999999")
        g.fields = ("#ffcd00", "#0202fb", "espn")  # gold type wouldn't show on Leeds' yellow
        self.assertEqual(g.team("home")["accent"], "#000000")

    def test_near_black_gives_way_to_the_alternate(self):
        h, a, how = partygames.club_colours(team("AAA", "", "#000000", "#c8102e"), team("BBB", "", "#0606fa", "#005f60"))
        self.assertEqual((h, a, how), ("#c8102e", "#0606fa", "alternate"))

    def test_a_clash_tries_the_away_alternate_then_the_home_one(self):
        # two reds: the away club changes
        h, a, _ = partygames.club_colours(team("BRE", "", "#f42727", "#0f1c3f"), team("NFO", "", "#e8102e", "#ffffff"))
        self.assertEqual((h, a), ("#f42727", "#ffffff"))
        # the away club has nothing else: the home club changes
        h, a, _ = partygames.club_colours(team("AAA", "", "#f42727", "#ffcd00"), team("BBB", "", "#e8102e", None))
        self.assertEqual((h, a), ("#ffcd00", "#e8102e"))

    def test_a_club_with_no_colour_gets_a_house_one(self):
        # Udinese (black, navy) at Roma (deep red): ivory stands further from the red than gold
        h, a, how = partygames.club_colours(team("UDI", "", "#19161d", "#0f1c3f"), team("ROMA", "", "#990a2c", "#f5f3e5"))
        self.assertEqual((h, a, how), (partygames.HOUSE_IVORY, "#990a2c", "house"))

    def test_nothing_works_so_gold_against_ivory(self):
        h, a, how = partygames.club_colours(team("AAA", "", "#101010", None), team("BBB", "", None, None))
        self.assertEqual(how, "house")
        self.assertEqual(h, partygames.GOLD)
        # identical colours, no alternates
        self.assertEqual(partygames.club_colours(team("A", "", "#c8102e", None), team("B", "", "#c8102e", None))[2], "house")

    def test_type_is_black_on_a_light_field(self):
        self.assertEqual(partygames.ink(partygames.dim("#ffffff")), "#000000")
        self.assertEqual(partygames.ink(partygames.dim("#144992")), partygames.IVORY)


class Calls(unittest.TestCase):
    def test_points(self):
        self.assertEqual(partygames.call_points((2, 1), 2, 1), 3)
        self.assertEqual(partygames.call_points((3, 0), 2, 1), 1)
        self.assertEqual(partygames.call_points((1, 1), 0, 0), 1)
        self.assertEqual(partygames.call_points((0, 2), 2, 1), 0)

    def test_who_pours(self):
        rows = [{"name": "A", "points": 3, "off": 0}, {"name": "B", "points": 0, "off": 4}, {"name": "C", "points": 0, "off": 2}]
        self.assertEqual(partygames.worst_calls(rows), ["B"])
        rows[2]["off"] = 4
        self.assertEqual(partygames.worst_calls(rows), ["B", "C"])
        self.assertEqual(partygames.worst_calls(rows[:1]), [])  # one call: nobody
        self.assertEqual(partygames.worst_calls([{"name": "A", "points": 1, "off": 2}, {"name": "B", "points": 1, "off": 2}]), [])


class SeasonTable(unittest.TestCase):
    def test_settles_once_and_resets(self):
        with tempfile.TemporaryDirectory() as tmp:
            s = partygames.Season(tmp)
            self.assertTrue(s.settle("m1", [{"name": "SAMI", "points": 3}, {"name": "LAYLA", "points": 1}]))
            self.assertFalse(s.settle("m1", [{"name": "SAMI", "points": 3}]))
            s.settle("m2", [{"name": "LAYLA", "points": 3}])
            self.assertEqual([(r["name"], r["points"], r["exact"]) for r in s.table()], [("LAYLA", 4, 1), ("SAMI", 3, 1)])
            partygames.Season(tmp).reset()  # from the control page: another instance
            self.assertEqual(s.table(), [])
            self.assertFalse(s.settle("m2", [{"name": "LAYLA", "points": 3}]))  # still settled


class Match(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.hub = make_hub(self.tmp.name)
        self.game = self.hub.party
        join(self.hub, "pid-sami", "Sami")
        join(self.hub, "pid-layla", "Layla")
        join(self.hub, "pid-omar", "Omar")

    def tearDown(self):
        self.tmp.cleanup()

    def pick(self, pid, side):
        send(self.hub, pid, "pick", id=side)

    def test_no_pin_is_the_lobby(self):
        with tempfile.TemporaryDirectory() as tmp:
            hub = make_hub(tmp, pinned=False)
            self.assertEqual(hub.party.phase, "lobby")
            self.assertEqual(hub.party.pad("x")["ui"], "wait")
            self.assertIsNone(hub.party.wants(hub.clock()))

    def test_sides_and_calls_before_kickoff(self):
        g = self.game
        self.assertEqual(g.phase, "pre")
        self.assertEqual(g.pad("pid-sami")["ui"], "pick")
        self.pick("pid-sami", "home")
        self.pick("pid-layla", "away")
        self.pick("pid-omar", "neutral")
        self.assertEqual(g.pad("pid-sami")["ui"], "call")
        send(self.hub, "pid-sami", "call", home=2, away=1, lock=True)
        send(self.hub, "pid-sami", "call", home=5, away=0, lock=True)  # locked: no change
        send(self.hub, "pid-layla", "call", home=0, away=3, lock=False)  # set, not locked: still counts
        wall = g.wall()
        self.assertEqual(wall["sides"], {"home": ["SAMI"], "away": ["LAYLA"], "neutral": ["OMAR"]})
        self.assertEqual(wall["called"], ["SAMI"])
        self.assertNotIn("2", json.dumps(wall.get("called")))
        self.assertNotIn("calls", json.dumps(wall))  # what anyone called stays off the wall till full time
        self.assertEqual(g.calls["pid-sami"]["home"], 2)
        # switching sides is fine before kickoff
        send(self.hub, "pid-omar", "pick", id="switch")
        self.assertEqual(g.pad("pid-omar")["ui"], "pick")
        self.pick("pid-omar", "home")
        until_kickoff(self.hub)
        self.assertEqual(g.phase, "live")
        self.assertEqual(g.pad("pid-sami")["ui"], "goal")
        send(self.hub, "pid-layla", "call", home=1, away=1, lock=True)  # too late
        self.assertFalse(g.calls["pid-layla"]["locked"])
        self.pick("pid-sami", "away")  # no turning coat after kickoff
        self.assertEqual(g.sides["pid-sami"], "home")

    def test_a_goal_the_tap_war_and_the_flood(self):
        g = self.game
        self.pick("pid-sami", "home")
        self.pick("pid-layla", "away")
        until_kickoff(self.hub)
        send(self.hub, "pid-omar", "goal", side="home")  # anyone can tap the goal
        self.assertEqual(g.phase, "push")
        self.assertEqual(g.wall()["score"], {"home": 1, "away": 0})
        self.assertEqual(g.pad("pid-sami")["label"], "TAP")
        self.assertEqual(g.pad("pid-layla")["label"], "SAVE")
        self.assertEqual(g.pad("pid-omar")["ui"], "pick")  # no side yet
        for _ in range(10):
            send(self.hub, "pid-sami", "tap", n=2)
        self.assertGreater(g.wall()["rule"], 0.7)  # pushed down toward the away edge
        for _ in range(10):
            send(self.hub, "pid-layla", "tap", n=2)
        self.assertAlmostEqual(g.push["p"], 0.2, places=5)  # a save is worth 0.6 of a tap
        for _ in range(20):
            send(self.hub, "pid-sami", "tap", n=2)
        self.assertEqual(g.phase, "flood")
        self.assertEqual(g.wall()["rule"], 1.0)
        run_for(self.hub, g.FLOOD + 0.5)
        self.assertEqual(g.phase, "live")
        self.assertEqual(g.wall()["rule"], 0.5)

    def test_the_same_goal_twice_counts_once_and_no_goal_takes_it_back(self):
        g = self.game
        self.pick("pid-sami", "home")
        self.pick("pid-layla", "neutral")
        until_kickoff(self.hub)
        send(self.hub, "pid-sami", "goal", side="away")
        self.assertEqual(g.phase, "flood")  # nobody supports them: straight to the flood
        run_for(self.hub, g.FLOOD + 1)
        send(self.hub, "pid-layla", "goal", side="away")
        self.assertEqual(g.score(), {"home": 0, "away": 1})
        self.assertEqual(g.pad("pid-layla")["notice"]["title"], "GOT IT")
        self.assertTrue(g.pad("pid-layla")["notice"]["plain"])  # no sip drop on a plain note
        self.assertTrue(g.pad("pid-sami")["undo"])
        send(self.hub, "pid-sami", "undo")
        self.assertEqual(g.score(), {"home": 0, "away": 0})
        self.assertEqual(g.wall()["note"], "NO GOAL")
        run_for(self.hub, g.NOTE + 0.5)
        self.assertNotIn("note", g.wall())
        run_for(self.hub, g.SAME_GOAL)
        send(self.hub, "pid-sami", "goal", side="away")
        self.assertEqual(g.score(), {"home": 0, "away": 1})

    def test_the_push_can_be_switched_off(self):
        with tempfile.TemporaryDirectory() as tmp:
            hub = make_hub(tmp, push=False)
            join(hub, "pid-ahmed", "Ahmed")
            send(hub, "pid-ahmed", "pick", id="home")
            until_kickoff(hub)
            send(hub, "pid-ahmed", "goal", side="home")
            self.assertEqual(hub.party.phase, "flood")

    def test_full_time_settles_from_espn_not_the_room(self):
        g, espn = self.game, self.hub.espn
        for pid, side, call in (("pid-sami", "home", (2, 1)), ("pid-layla", "away", (0, 2)), ("pid-omar", "neutral", (1, 0))):
            self.pick(pid, side)
            send(self.hub, pid, "call", home=call[0], away=call[1], lock=True)
        until_kickoff(self.hub)
        send(self.hub, "pid-sami", "goal", side="home")  # the room only saw one
        run_for(self.hub, g.PUSH + 1)
        espn.match = espn_match("post", True, 2, 1, "FT")
        send(self.hub, "pid-sami", "fulltime")
        self.assertEqual(g.phase, "ftwait")
        asked = espn.asked
        self.hub.poll()  # straight away: full time asks ESPN at once
        self.assertEqual(espn.asked, asked + 1)
        self.assertEqual(g.phase, "fulltime")
        r = g.wall()["result"]
        self.assertEqual((r["home"], r["away"], r["winner"]), (2, 1, "home"))
        self.assertEqual(r["called"], ["SAMI"])
        self.assertTrue(r["exact"])
        self.assertEqual(r["losers"], ["LAYLA"])  # 0 points and 2 goals out, worse than Omar's 1-0
        self.assertEqual(g.wall()["rule"], 1.0)  # the winner's colour holds the wall
        self.assertEqual([(t["name"], t["points"]) for t in g.wall()["table"]], [("SAMI", 3), ("OMAR", 1), ("LAYLA", 0)])
        self.assertEqual(g.wall()["forfeit"], "LOSER POURS")
        self.assertEqual(g.pad("pid-sami")["big"], "Exact")
        self.assertIn("Loser pours", g.pad("pid-layla")["text"])
        self.assertIsNone(g.wants(self.hub.clock() + 999))  # nothing more to ask ESPN
        run_for(self.hub, g.HOLD + 0.5)
        self.assertEqual(g.phase, "table")
        run_for(self.hub, g.CARD + 0.5)
        self.assertEqual(g.phase, "fulltime")

    def test_espn_full_time_settles_on_its_own_after_a_while(self):
        g, espn = self.game, self.hub.espn
        until_kickoff(self.hub)
        espn.match = espn_match("post", True, 0, 0, "FT")
        self.hub.poll()
        self.assertEqual(g.phase, "live")  # not straight away: the stream may be behind
        run_for(self.hub, g.SETTLE_AFTER + 1)
        self.assertEqual(g.phase, "fulltime")

    def test_a_dead_feed_falls_back_to_the_room(self):
        g, espn = self.game, self.hub.espn
        until_kickoff(self.hub)
        send(self.hub, "pid-sami", "goal", side="away")
        run_for(self.hub, g.FLOOD + 1)
        espn.down = True
        send(self.hub, "pid-sami", "fulltime")
        self.hub.poll()
        self.assertEqual(g.phase, "ftwait")
        send(self.hub, "pid-sami", "resume")  # not over after all
        self.assertEqual(g.phase, "live")
        send(self.hub, "pid-sami", "fulltime")
        run_for(self.hub, g.GIVE_UP + 1)
        self.assertEqual(g.phase, "fulltime")
        self.assertEqual((g.result["home"], g.result["away"], g.result["source"]), (0, 1, "room"))

    def test_the_wall_never_carries_espns_live_score(self):
        g, espn = self.game, self.hub.espn
        until_kickoff(self.hub)
        espn.match = espn_match("in", False, 3, 2, "60'")
        self.hub.poll()
        wall = json.dumps(g.wall())
        self.assertEqual(g.wall()["score"], {"home": 0, "away": 0})
        self.assertNotIn('"score": "3"', wall)
        self.assertNotIn("60'", wall)
        for pid in ("pid-sami", "pid-layla"):
            self.assertNotIn("60'", json.dumps(g.pad(pid)))

    def test_a_restart_keeps_the_match(self):
        g = self.game
        self.pick("pid-sami", "home")
        send(self.hub, "pid-sami", "call", home=1, away=0, lock=True)
        until_kickoff(self.hub)
        send(self.hub, "pid-layla", "goal", side="home")
        hub2 = server.GameHub.__new__(server.GameHub)
        hub2.clock = self.hub.clock
        hub2.espn = FakeEspn()
        server.GameHub.__init__(hub2, self.hub.store)
        g2 = hub2.party
        self.assertEqual(g2.sides["pid-sami"], "home")
        self.assertTrue(g2.calls["pid-sami"]["locked"])
        self.assertEqual(g2.score(), {"home": 1, "away": 0})
        self.assertEqual(g2.phase, "live")

    def test_a_new_pin_starts_afresh(self):
        g = self.game
        self.pick("pid-sami", "home")
        other = espn_match()
        other["id"] = "402"
        self.hub.store.state["channels"]["colours"]["pin"] = other
        self.hub.tick()
        self.assertEqual(g.pin_id, "402")
        self.assertEqual(g.sides, {})
        self.hub.store.state["channels"]["colours"]["pin"] = None
        self.hub.tick()
        self.assertEqual(g.phase, "lobby")


class Inputs(unittest.TestCase):
    def test_new_kinds_are_checked(self):
        check = server.GameHub._check_input
        self.assertEqual(check("call", {"home": 2.4, "away": 99, "lock": True}), {"kind": "call", "home": 2, "away": 20, "lock": True})
        self.assertEqual(check("goal", {"side": "home"}), {"kind": "goal", "side": "home"})
        self.assertEqual(check("tap", {"n": 500}), {"kind": "tap", "n": 40})
        self.assertEqual(check("tap", {}), {"kind": "tap"})  # the arcade games' plain tap
        for kind, body in (("goal", {"side": "neutral"}), ("call", {"home": "2", "away": 1})):
            with self.assertRaises(ValueError):
                check(kind, body)
        for kind in ("undo", "fulltime", "resume"):
            self.assertEqual(check(kind, {}), {"kind": kind})


class Espn(unittest.TestCase):
    def test_board_parsing(self):
        raw = {"events": [{"id": "401879250", "date": "2026-10-31T20:00Z", "competitions": [{
            "status": {"type": {"state": "pre", "completed": False, "shortDetail": "Sat 8:00 PM"}},
            "competitors": [{"homeAway": "home", "score": "0", "team": {"abbreviation": "AVL", "shortDisplayName": "Aston Villa", "color": "660e36", "alternateColor": "000000"}},
                            {"homeAway": "away", "score": "0", "team": {"abbreviation": "FUL", "shortDisplayName": "Fulham", "color": "ffffff", "alternateColor": "CC0000"}}]}]}]}
        asked = []
        real = server.fetch_url
        server.fetch_url = lambda url, timeout=8: (asked.append(url), json.dumps(raw).encode())[1]
        try:
            day = datetime.date(2026, 10, 31)
            m = server.espn_board("eng.1", day)[0]
            self.assertTrue(asked[0].endswith("/soccer/eng.1/scoreboard?dates=20261031"))  # one day: ESPN refuses ranges
            self.assertEqual((m["id"], m["home"]["abbr"], m["home"]["color"], m["away"]["alt"]), ("401879250", "AVL", "#660e36", "#cc0000"))
            self.assertEqual(server.find_match("eng.1", "401879250", "2026-10-31T20:00Z")["away"]["name"], "Fulham")
            self.assertTrue(asked[1].endswith("/scoreboard"))  # its current matchday first
            self.assertIsNone(server.find_match("eng.1", "999", "2026-10-31T20:00Z"))
        finally:
            server.fetch_url = real


if __name__ == "__main__":
    unittest.main()
