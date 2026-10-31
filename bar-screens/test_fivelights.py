#!/usr/bin/env python3
"""Tests for Five Lights: the deck, house prompts, tiers, Room prompts, bulbs, sips, TELL IT and the
end of a game, all through the game hub. Standard library only:  python3 test_fivelights.py"""

import json
import os
import tempfile
import unittest

import partygames
import server
from test_party import iter_queue, join, make_hub, run_for, send


def start(hub, *people, sips=False):
    """Joins people ([(pid, name, drinks)]) and starts a game, up to the first prompt."""
    for pid, name, drinks in people:
        join(hub, pid, name, drinks)
    send(hub, people[0][0], "start")
    run_for(hub, hub.party.CARD + 0.5)


def answer_all(hub, answers):
    """Answers the current prompt ({pid: True/False}) and runs to the reveal."""
    for pid, yes in answers.items():
        send(hub, pid, "yesno", yes=yes)
    while hub.party.phase == "ask":
        run_for(hub, 0.25)


THREE = [("pid-sami", "Sami", True), ("pid-layla", "Layla", True), ("pid-omar", "Omar", False)]


class Deck(unittest.TestCase):
    def test_nights_deck(self):
        items = partygames.load_deck("nights")
        self.assertGreaterEqual(len(items), 300)
        for tier in partygames.TIERS:
            mine = [i for i in items if i["tier"] == tier]
            self.assertGreaterEqual(len([i for i in mine if not i["room"]]), 60, tier)
            self.assertGreaterEqual(len([i for i in mine if i["room"]]), 15, tier)
        for i in items:
            self.assertIn(i["tier"], partygames.TIERS, i["id"])
            self.assertLessEqual(len(i["text"]), partygames.HOUSE_MAX, i["id"])
            self.assertEqual(i["text"], i["text"].upper(), i["id"])

    def test_house_prompts(self):
        items, bad = partygames.parse_house(
            "Never have I ever lost Omar's car keys.\n# a comment\n\n  slept   at the basement  \n"
            + "x" * 41 + "\nNEVER HAVE I EVER: slept at the basement\n")
        self.assertEqual([i["text"] for i in items], ["LOST OMAR'S CAR KEYS", "SLEPT AT THE BASEMENT"])
        self.assertEqual(bad, [5])
        self.assertTrue(all(i["id"].startswith("h-") and not i["room"] for i in items))


class Game(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def hub(self, sips=False):
        return make_hub(self.tmp.name, game="fivelights", sips=sips)

    def test_needs_two(self):
        hub = self.hub()
        join(hub, "pid-sami", "Sami")
        send(hub, "pid-sami", "start")
        self.assertEqual(hub.party.phase, "lobby")
        self.assertEqual(hub.party.pad("pid-sami")["notice"]["title"], "ONE MORE")
        join(hub, "pid-layla", "Layla")
        send(hub, "pid-sami", "start")
        self.assertEqual(hub.party.phase, "card")

    def test_tier_from_the_lobby(self):
        hub = self.hub()
        join(hub, "pid-sami", "Sami")
        self.assertEqual(hub.party.pad("pid-sami")["chosen"], "mild")
        send(hub, "pid-sami", "pick", id="cheeky")
        self.assertEqual(hub.store.state["channels"]["games"]["tier"], "cheeky")
        self.assertEqual(hub.party.wall()["lines"][-1], "CHEEKY PROMPTS")
        send(hub, "pid-sami", "pick", id="spicy")  # not a tier: ignored
        self.assertEqual(hub.store.state["channels"]["games"]["tier"], "cheeky")
        hub.store.update_channels({"games": {"tier": "dubai"}})
        self.assertEqual(hub.party.tier(), "dubai")

    def test_prompts_follow_the_tier(self):
        hub = self.hub()
        hub.store.update_channels({"games": {"tier": "dubai"}})
        g = hub.party
        start(hub, *THREE)
        tiers, rooms, seen = [], 0, set()
        for n in range(1, 31):
            item = g.pick_prompt(n % 5 == 0)
            self.assertNotIn(item["id"], seen)  # no repeats
            seen.add(item["id"])
            if item["room"]:
                rooms += 1
                self.assertIn(item["tier"], ("mild", "dubai"))
            else:
                tiers.append(item["tier"])
        self.assertEqual(rooms, 6)
        self.assertNotIn("cheeky", tiers)
        self.assertGreater(tiers.count("dubai"), tiers.count("mild") > 0)

    def test_house_prompts_mixed_in(self):
        hub = self.hub()
        with open(os.path.join(self.tmp.name, "house.txt"), "w") as f:
            f.write("lost Omar's car keys\nslept at the basement\n")
        g = hub.party
        start(hub, *THREE)
        texts = [g.pick_prompt(False)["text"] for _ in range(8)]
        self.assertEqual(sorted(t for t in texts if t in ("LOST OMAR'S CAR KEYS", "SLEPT AT THE BASEMENT")),
                         ["LOST OMAR'S CAR KEYS", "SLEPT AT THE BASEMENT"])

    def test_a_prompt(self):
        hub = self.hub(sips=True)
        g = hub.party
        wall_q = hub.subscribe("display", None)
        start(hub, *THREE)
        self.assertEqual((g.phase, g.n, g.data["room"]), ("ask", 1, False))
        pad = g.pad("pid-omar")
        self.assertEqual((pad["ui"], pad["yes"], pad["no"], pad["prompt"]), ("yesno", "I have", "Never", g.data["text"]))
        self.assertEqual(pad["lights"], {"lit": 5, "of": 5})
        # answers can change until the clock runs out; nobody locks
        send(hub, "pid-sami", "yesno", yes=False)
        send(hub, "pid-sami", "yesno", yes=True)
        send(hub, "pid-layla", "yesno", yes=True)
        self.assertEqual([p["answered"] for p in g.wall()["players"]], [True, True, False])
        self.assertEqual(g.phase, "ask")
        send(hub, "pid-omar", "yesno", yes=True)  # everyone in: two seconds more, then the reveal
        run_for(hub, 1.5)
        self.assertEqual(g.phase, "ask")
        send(hub, "pid-omar", "yesno", yes=False)
        run_for(hub, 1.0)
        self.assertEqual(g.phase, "reveal")
        self.assertEqual((g.data["count"], g.data["answered"]), (2, 3))
        self.assertEqual(g.bulbs, {"pid-sami": 4, "pid-layla": 4, "pid-omar": 5})
        # the bulbs go out one at a time, with the sip, and the phone keeps step with the wall
        first, second = g.data["outs"]
        self.assertEqual(g.pad("pid-layla")["ui"], "wait")
        run_for(hub, first["at"] + 0.1)
        self.assertEqual(g.pad("pid-sami")["lights"]["lit"], 4)
        self.assertEqual(g.pad("pid-layla")["lights"]["lit"], 5)
        self.assertIn("notice", g.pad("pid-sami"))
        self.assertNotIn("notice", g.pad("pid-layla"))
        run_for(hub, second["at"] - first["at"])
        self.assertEqual(g.pad("pid-layla")["notice"]["title"], "A SIP")
        # Omar said never and isn't drinking anyway: no sip, no drop
        self.assertNotIn("pid-omar", g.drops)
        self.assertEqual(g.pad("pid-omar")["big"], "Never")
        walls = [json.loads(m) for m in iter_queue(wall_q) if '"party"' in m]
        self.assertFalse(any("drinks" in json.dumps(w) for w in walls))
        self.assertEqual(sorted(p["name"] for p in g.wall()["players"] if p["drop"]), ["LAYLA", "SAMI"])
        run_for(hub, g.data["times"]["end"])
        self.assertEqual((g.phase, g.n), ("ask", 2))

    def test_drinker_who_said_no_gets_no_sip(self):
        hub = self.hub(sips=True)
        g = hub.party
        start(hub, *THREE)
        answer_all(hub, {"pid-omar": True, "pid-sami": False})
        run_for(hub, g.data["times"]["end"] - 0.5)
        self.assertEqual(g.bulbs["pid-omar"], 4)
        self.assertEqual(g.drops, {})  # Omar lost a bulb but isn't drinking; Sami said never

    def test_room_prompt(self):
        hub = self.hub(sips=True)
        g = hub.party
        start(hub, *THREE)
        for n in range(1, 5):
            answer_all(hub, {"pid-sami": False, "pid-layla": False, "pid-omar": False})
            run_for(hub, g.data["times"]["end"])
        self.assertEqual((g.phase, g.n, g.data["room"]), ("ask", 5, True))
        self.assertTrue(g.prompt["room"])
        self.assertEqual(g.pad("pid-sami")["title"], "The room · no names")
        answer_all(hub, {"pid-sami": True, "pid-layla": True, "pid-omar": False})
        self.assertEqual((g.phase, g.data["pct"]), ("reveal", 67))
        wall = g.wall()
        self.assertNotIn("have", wall)
        self.assertEqual([p["lit"] for p in wall["players"]], [5, 5, 5])  # nobody loses a bulb
        self.assertEqual(g.drops, {})
        send(hub, "pid-sami", "buzz")  # no stories on Room prompts
        self.assertIsNone(g.teller)
        self.assertEqual(g.pad("pid-sami")["big"], "67%")

    def test_tell_it(self):
        hub = self.hub()
        g = hub.party
        start(hub, *THREE)
        answer_all(hub, {"pid-sami": True, "pid-layla": False})
        send(hub, "pid-sami", "buzz")  # too early: the bulbs are still going out
        self.assertIsNone(g.teller)
        run_for(hub, g.data["times"]["tell"])
        pad = g.pad("pid-sami")
        self.assertEqual(pad["buttons"], [{"kind": "buzz", "label": "Tell it", "quiet": True}])
        self.assertEqual(g.pad("pid-layla")["ui"], "result")  # said never: no button
        send(hub, "pid-layla", "buzz")
        self.assertIsNone(g.teller)
        send(hub, "pid-sami", "buzz")
        self.assertEqual(g.teller, "pid-sami")
        self.assertEqual(g.pad("pid-sami")["buttons"], [])
        run_for(hub, 1.25)
        self.assertEqual((g.phase, g.data["name"]), ("story", "SAMI"))
        self.assertEqual(g.pad("pid-sami")["buttons"][0]["label"], "Done")
        self.assertEqual(g.pad("pid-omar")["text"], "SAMI has the floor.")
        send(hub, "pid-layla", "next")  # only the teller ends it
        self.assertEqual(g.phase, "story")
        send(hub, "pid-sami", "next")
        self.assertEqual((g.phase, g.n), ("ask", 2))

    def test_story_runs_out(self):
        hub = self.hub()
        g = hub.party
        start(hub, *THREE)
        answer_all(hub, {"pid-layla": True})
        run_for(hub, g.data["times"]["tell"])
        send(hub, "pid-layla", "buzz")
        run_for(hub, 1.25)
        run_for(hub, g.STORY + 0.25)
        self.assertEqual(g.phase, "ask")

    def play_until_over(self, hub, answers):
        g = hub.party
        for _ in range(40):
            if g.phase == "podium":
                return
            self.assertEqual(g.phase, "ask")
            n = g.n
            answer_all(hub, answers if not g.data["room"] else {})
            while g.phase not in ("ask", "podium") or g.n == n and g.phase == "ask":
                run_for(hub, 0.5)
        self.fail("the game never ended")

    def test_last_one_lit_wins_and_relight(self):
        hub = self.hub()
        g = hub.party
        start(hub, *THREE)
        self.play_until_over(hub, {"pid-sami": True, "pid-layla": True, "pid-omar": False})
        self.assertEqual([w["name"] for w in g.data["winners"]], ["OMAR"])
        self.assertEqual(g.data["spare"], 5)
        self.assertEqual(g.night, {"pid-omar": 1})
        self.assertEqual(g.pad("pid-omar")["big"], "Last one lit")
        self.assertEqual(g.pad("pid-sami")["buttons"][0], {"kind": "next", "label": "Relight"})
        send(hub, "pid-sami", "next")
        self.assertEqual((g.phase, g.round), ("card", 2))
        self.assertEqual(set(g.bulbs.values()), {5})
        self.assertEqual(g.data["night"][0]["name"], "OMAR")

    def test_last_ones_out_together_share_it(self):
        hub = self.hub()
        g = hub.party
        start(hub, *THREE)
        self.play_until_over(hub, {"pid-sami": True, "pid-layla": True, "pid-omar": True})
        self.assertEqual([w["name"] for w in g.data["winners"]], ["SAMI", "LAYLA", "OMAR"])
        send(hub, "pid-omar", "end")
        self.assertEqual(g.phase, "lobby")

    def test_out_players_play_along(self):
        hub = self.hub(sips=True)
        g = hub.party
        start(hub, *THREE)
        g.bulbs["pid-sami"] = 0
        answer_all(hub, {"pid-sami": True, "pid-layla": False, "pid-omar": False})
        self.assertEqual(g.data["have"], [hub.players["pid-sami"]["slot"]])
        self.assertEqual(g.data["outs"], [])  # nothing left to lose, so no sip either
        run_for(hub, g.data["times"]["tell"])
        self.assertEqual(g.pad("pid-sami")["text"], "You have. No bulbs left to lose.")
        self.assertEqual(g.drops, {})

    def test_late_arrival_comes_in_level(self):
        hub = self.hub()
        g = hub.party
        start(hub, *THREE)
        g.bulbs.update({"pid-sami": 2, "pid-layla": 4, "pid-omar": 0})
        join(hub, "pid-noor", "Noor")
        self.assertEqual(g.bulbs["pid-noor"], 2)
        self.assertEqual(next(p["lit"] for p in g.wall()["players"] if p["name"] == "NOOR"), 2)

    def test_house_list_endpoint(self):
        handler = server.Handler.__new__(server.Handler)
        handler.store = server.Store(self.tmp.name)
        r = handler._list("house", "slept at the basement\n" + "y" * 50)
        self.assertEqual((r["count"], r["bad"]), (1, [2]))
        self.assertEqual(handler._list("house")["count"], 1)
        self.assertEqual(handler._list("years")["count"], 0)


if __name__ == "__main__":
    unittest.main()
