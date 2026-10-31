#!/usr/bin/env python3
"""Tests for The Verdict: the decks, guests' prompts, the count, the pace, the host's controls and
the sips rules, through the game hub. Standard library only:  python3 test_verdict.py"""

import json
import tempfile
import unittest

import partygames
import server
from test_party import join, make_hub, run_for, send


def pid_of(hub, name):
    return next(pid for pid, p in hub.players.items() if p["name"] == name)


def slot_of(hub, name):
    return hub.players[pid_of(hub, name)]["slot"]


def vote(hub, voter, for_name):
    send(hub, pid_of(hub, voter), "pick", id=str(slot_of(hub, for_name)), choice=0)


class Prompts(unittest.TestCase):
    def test_clean(self):
        c = partygames.clean_prompt
        self.assertEqual(c("who's most likely to   lose their phone?"), "LOSE THEIR PHONE")
        self.assertEqual(c("Most likely to cry at a wedding"), "CRY AT A WEDDING")
        self.assertEqual(c("WHO IS MOST LIKELY TO sing"), "SING")
        self.assertEqual(c("x" * partygames.PROMPT_MAX), "X" * partygames.PROMPT_MAX)
        for bad in ("", "  ", "ok", "x" * (partygames.PROMPT_MAX + 1), "123 456", None):
            self.assertIsNone(c(bad), bad)

    def test_decks(self):
        items = partygames.load_deck("verdict")
        for section in partygames.Verdict.DECKS:
            mine = [i for i in items if i["section"] == section]
            self.assertGreaterEqual(len(mine), 60, section)
            for i in mine:
                self.assertEqual(partygames.clean_prompt(i["text"]), i["text"], i["id"])  # sets huge as it is
                self.assertLessEqual(len(i["text"].split()), 7, i["id"])
        self.assertEqual(len({i["id"] for i in items}), len(items))

    def test_tally(self):
        self.assertEqual(partygames.tally({"a": 1, "b": 1, "c": 2}), ({1: 2, 2: 1}, [1]))
        self.assertEqual(partygames.tally({"a": 1, "b": 2}), ({1: 1, 2: 1}, [1, 2]))
        self.assertEqual(partygames.tally({}), ({}, []))
        self.assertLessEqual(partygames.rise_beat(7) * 7, 5)
        self.assertEqual(partygames.rise_beat(1), 0.8)


class Game(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.hub = make_hub(self.tmp.name, "verdict", sips=True)
        self.hub.store.party_info = self.hub.host_info
        self.game = self.hub.party
        self.assertIsInstance(self.game, partygames.Verdict)

    def tearDown(self):
        self.tmp.cleanup()

    def seat(self, *names, drinks=None):
        for i, name in enumerate(names):
            join(self.hub, f"phone-{name.lower()}", name, (drinks or {}).get(name))

    def test_needs_three(self):
        self.seat("LAYLA", "SAMI")
        self.assertEqual(self.game.wall()["note"], "NEEDS ONE MORE PLAYER")
        send(self.hub, "phone-layla", "start")
        self.assertEqual(self.game.phase, "lobby")
        self.seat("OMAR")
        self.assertNotIn("note", self.game.wall())
        send(self.hub, "phone-layla", "start")
        self.assertEqual(self.game.phase, "vote")

    def test_a_whole_prompt(self):
        self.seat("LAYLA", "SAMI", "OMAR", "NOOR", drinks={"SAMI": True, "OMAR": False})
        send(self.hub, "phone-layla", "start")
        g = self.game
        self.assertEqual(g.phase, "vote")
        wall = g.wall()
        self.assertEqual((wall["in"], wall["of"], wall["lead"]), (0, 4, "WHO'S MOST LIKELY TO"))
        # each phone gets everyone but themselves
        pad = g.pad("phone-layla")
        self.assertEqual(pad["ui"], "pick")
        self.assertEqual([o["label"] for o in pad["options"]], ["SAMI", "OMAR", "NOOR"])
        self.assertNotIn("suggest", pad)  # no writing while the room votes
        # voting for yourself, or for nobody here, does nothing
        vote(self.hub, "LAYLA", "LAYLA")
        send(self.hub, "phone-layla", "pick", id="7", choice=0)
        self.assertEqual(g.wall()["in"], 0)
        vote(self.hub, "LAYLA", "NOOR")
        vote(self.hub, "LAYLA", "SAMI")  # a change of mind
        vote(self.hub, "SAMI", "OMAR")
        vote(self.hub, "OMAR", "SAMI")
        self.assertEqual(g.wall()["in"], 3)
        self.assertEqual(g.pad("phone-layla")["chosen"], str(slot_of(self.hub, "SAMI")))
        until = g.until
        vote(self.hub, "NOOR", "SAMI")
        self.assertLess(g.until, until)  # everyone's in: the reveal comes early
        run_for(self.hub, 2)
        self.assertEqual(g.phase, "reveal")
        bars = {b["name"]: b["votes"] for b in g.wall()["bars"]}
        self.assertEqual(bars, {"SAMI": 3, "OMAR": 1})
        self.assertEqual(g.pad("phone-layla")["text"], "You voted Sami.")
        run_for(self.hub, g.until - g.now() + 0.3)
        self.assertEqual(g.phase, "verdict")
        wall = g.wall()
        self.assertTrue(wall["guilty"])
        self.assertEqual((wall["names"], wall["votes"]), (["SAMI"], 3))
        self.assertEqual(g.pad("phone-sami")["big"], "Guilty")
        self.assertEqual(g.pad("phone-omar")["big"], "Sami")
        # Sami said he's drinking: a sip, shown only as a drop by his name
        sami = next(p for p in wall["players"] if p["name"] == "SAMI")
        self.assertIsNotNone(sami["drop"])
        self.assertEqual(g.pad("phone-sami")["notice"]["title"], "GUILTY")
        self.assertNotIn("drinks", json.dumps(wall))
        run_for(self.hub, g.until - g.now() + 0.3)
        self.assertEqual(g.phase, "card")
        self.assertEqual(g.wall()["most"], {"names": ["SAMI"], "count": 1})
        # auto pace: the next prompt goes up two minutes after this one did
        self.assertAlmostEqual(g.until, g.started + g.PACE)
        self.assertIn("suggest", g.pad("phone-layla"))
        run_for(self.hub, g.until - g.now() + 0.3)
        self.assertEqual(g.phase, "vote")
        self.assertEqual(g.wall()["n"], 2)

    def test_hung_jury_and_no_sips_for_the_not_drinking(self):
        self.seat("LAYLA", "SAMI", "OMAR", drinks={"LAYLA": False, "SAMI": False, "OMAR": False})
        send(self.hub, "phone-layla", "start")
        vote(self.hub, "LAYLA", "SAMI")
        vote(self.hub, "SAMI", "OMAR")
        run_for(self.hub, 31)
        self.assertEqual(self.game.phase, "reveal")
        run_for(self.hub, self.game.until - self.game.now() + 0.3)
        wall = self.game.wall()
        self.assertFalse(wall["guilty"])
        self.assertEqual(wall["names"], ["SAMI", "OMAR"])
        self.assertEqual(self.game.pad("phone-omar")["big"], "Hung jury")
        self.assertTrue(all(p["drop"] is None for p in wall["players"]))
        run_for(self.hub, 10)
        self.assertIsNone(self.game.wall()["most"])  # a hung jury convicts nobody

    def test_nobody_votes(self):
        self.seat("LAYLA", "SAMI", "OMAR")
        send(self.hub, "phone-sami", "start")
        run_for(self.hub, 31)
        self.assertEqual(self.game.phase, "verdict")
        self.assertEqual(self.game.wall()["names"], [])
        self.assertEqual(self.game.pad("phone-sami")["big"], "No verdict")

    def test_guests_prompts_wait_for_the_host(self):
        self.seat("LAYLA", "SAMI", "OMAR")
        g = self.game
        send(self.hub, "phone-omar", "suggest", text="most likely to " + "a very long one " * 4)
        self.assertEqual(g.pad("phone-omar")["notice"]["title"], "TRY AGAIN")
        send(self.hub, "phone-omar", "suggest", text="Who's most likely to cry at the wedding?")
        self.assertEqual(g.pad("phone-omar")["notice"]["title"], "SENT TO THE HOST")
        send(self.hub, "phone-omar", "suggest", text="cry at the wedding")
        self.assertEqual(g.pad("phone-omar")["notice"]["title"], "ALREADY IN")
        send(self.hub, "phone-layla", "suggest", text="steal the aux")
        host = json.loads(self.hub.store.snapshot())["party"]
        self.assertEqual([(w["text"], w["by"]) for w in host["waiting"]], [("CRY AT THE WEDDING", "OMAR"), ("STEAL THE AUX", "LAYLA")])
        self.assertNotIn("pid", json.dumps(host))
        self.hub.host({"action": "bin", "id": host["waiting"][1]["id"]})
        self.hub.host({"action": "approve", "id": host["waiting"][0]["id"]})
        self.assertEqual(g.pad("phone-omar")["notice"]["title"], "APPROVED")
        self.assertEqual((g.host()["waiting"], g.host()["approved"]), ([], ["CRY AT THE WEDDING"]))
        send(self.hub, "phone-layla", "start")
        self.assertEqual(g.wall()["text"], "CRY AT THE WEDDING")
        self.assertTrue(g.wall()["guest"])
        # nothing from guests reaches the wall without the host
        for n in range(5):
            send(self.hub, "phone-sami", "suggest", text=f"dance on table {n + 1}")
        self.assertEqual(len(g.host()["waiting"]), g.PER_PHONE)
        self.hub.host({"action": "next"})
        self.assertFalse(g.wall()["guest"])
        with self.assertRaises(server.ApiError):
            self.hub.host({"action": "launch"})

    def test_by_hand_and_the_host_skipping(self):
        self.hub.store.update_channels({"games": {"verdictPace": "hand", "verdictDeck": "gamenight"}})
        self.seat("LAYLA", "SAMI", "OMAR")
        g = self.game
        night = {i["text"] for i in partygames.load_deck("verdict") if i["section"] == "gamenight"}
        self.hub.host({"action": "next"})  # the host starts it from the control page
        self.assertEqual(g.phase, "vote")
        self.assertIn(g.wall()["text"], night)
        first = g.wall()["text"]
        vote(self.hub, "LAYLA", "SAMI")
        self.hub.host({"action": "next"})  # skip this one
        self.assertEqual(g.phase, "vote")
        self.assertNotEqual(g.wall()["text"], first)
        self.assertEqual(g.wall()["in"], 0)
        run_for(self.hub, 31)
        run_for(self.hub, 12)
        self.assertEqual(g.phase, "card")
        self.assertIsNone(g.until)
        run_for(self.hub, 300)
        self.assertEqual(g.phase, "card")  # by hand: it waits
        self.assertEqual([b["kind"] for b in g.pad("phone-omar")["buttons"]], ["next", "end"])
        # switching to auto while the card is up starts the clock
        self.hub.store.update_channels({"games": {"verdictPace": "auto"}})
        run_for(self.hub, 0.5)
        self.assertIsNotNone(g.until)
        self.hub.store.update_channels({"games": {"verdictPace": "hand"}})
        run_for(self.hub, 0.5)
        send(self.hub, "phone-omar", "next")
        self.assertEqual(g.phase, "vote")

    def test_no_repeats_across_a_night(self):
        self.seat("LAYLA", "SAMI", "OMAR")
        send(self.hub, "phone-layla", "start")
        seen = [self.game.wall()["text"]]
        for _ in range(59):
            self.hub.host({"action": "next"})
            seen.append(self.game.wall()["text"])
        self.assertEqual(len(set(seen)), 60)

    def test_a_trip_to_another_game_keeps_it(self):
        self.seat("LAYLA", "SAMI", "OMAR")
        g = self.game
        send(self.hub, "phone-omar", "suggest", text="steal the aux")
        send(self.hub, "phone-layla", "start")
        vote(self.hub, "LAYLA", "SAMI")
        self.hub.store.update_screen("s1", {"channel": "games"})  # 6, and back to 11
        self.hub.roster_changed()
        self.assertIsNot(self.hub.party, g)
        self.hub.store.update_screen("s1", {"channel": "verdict"})
        self.hub.roster_changed()
        self.assertIs(self.hub.party, g)
        self.assertEqual((g.phase, g.wall()["in"]), ("vote", 1))
        self.assertEqual(len(g.host()["waiting"]), 1)
        # left for longer than half an hour: a fresh lobby
        self.hub.store.update_screen("s1", {"channel": "games"})
        self.hub.roster_changed()
        self.hub.clock.t += server.GameHub.PARKED_FOR + 1
        self.hub.store.update_screen("s1", {"channel": "verdict"})
        self.hub.roster_changed()
        self.assertEqual(self.hub.party.phase, "lobby")

    def test_input_check(self):
        self.assertEqual(server.GameHub._check_input("suggest", {"text": "steal the aux"}), {"kind": "suggest", "text": "steal the aux"})
        with self.assertRaises(ValueError):
            server.GameHub._check_input("suggest", {"text": 5})

    def test_host_without_a_party_game(self):
        hub = make_hub(self.tmp.name, "breaker")
        hub.store.party_info = hub.host_info
        with self.assertRaises(server.ApiError):
            hub.host({"action": "next"})
        self.assertIsNone(json.loads(hub.store.snapshot())["party"])


if __name__ == "__main__":
    unittest.main()
