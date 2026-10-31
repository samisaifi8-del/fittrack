#!/usr/bin/env python3
"""Tests for Five Clues: the deck, a round's cards, fair buzzing, lockouts, the falling value,
the sips rules and a whole round through the game hub. Standard library only:
python3 test_fiveclues.py"""

import json
import tempfile
import unittest

import partygames
from test_party import iter_queue, join, make_hub, run_for, send


def start(hub, pid):
    """From the lobby to the first clue of the first card."""
    g = hub.party
    send(hub, pid, "start")
    run_for(hub, g.CARD + 0.25)
    assert g.phase == "clue", g.phase
    return g


def right(g):
    return g.item()["answer"]


def wrong(g):
    return g.item()["decoys"][0]


class Deck(unittest.TestCase):
    def test_clue_deck(self):
        items = partygames.load_deck("clues")
        self.assertGreaterEqual(len(items), 120)
        groups = {}
        for i in items:
            self.assertIn(i["type"], partygames.CLUE_GROUPS, i["id"])
            groups.setdefault(partygames.CLUE_GROUPS[i["type"]], 0)
            groups[partygames.CLUE_GROUPS[i["type"]]] += 1
            self.assertEqual(len(i["clues"]), 5, i["id"])
            self.assertTrue(all(len(c) <= 18 for c in i["clues"]), i["id"])  # reads at 256 px
            self.assertEqual(len(set(i["decoys"])), 3, i["id"])
            self.assertNotIn(i["answer"], i["decoys"], i["id"])
        self.assertEqual(len(groups), 6)

    def test_leaders_line(self):
        row = lambda name, place, pts: {"name": name, "place": place, "points": pts}
        self.assertEqual(partygames.leaders_line([]), "NO SCORES YET")
        self.assertEqual(partygames.leaders_line([row("SAMI", 1, 4), row("OMAR", 2, 1)]), "SAMI LEADS")
        self.assertEqual(partygames.leaders_line([row("SAMI", 1, 4), row("OMAR", 1, 4)]), "SAMI & OMAR LEAD")
        self.assertEqual(partygames.leaders_line([row("A", 1, 2), row("B", 1, 2), row("C", 1, 2)]), "3-WAY TIE")


class Game(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def hub(self, sips=False):
        return make_hub(self.tmp.name, game="fiveclues", sips=sips)

    def test_a_round_has_one_card_of_each_type(self):
        hub = self.hub()
        join(hub, "pid-sami", "Sami")
        g = start(hub, "pid-sami")
        self.assertEqual(len(g.cards), 6)
        self.assertEqual(len({partygames.CLUE_GROUPS[c["type"]] for c in g.cards}), 6)
        # the next rounds don't repeat a card until a type runs out
        seen = {c["id"] for c in g.cards}
        for _ in range(9):
            g.next_round()
            ids = {c["id"] for c in g.cards}
            self.assertFalse(ids & seen)
            seen |= ids

    def test_value_drops_and_nobody_scores(self):
        hub = self.hub()
        join(hub, "pid-sami", "Sami")
        g = start(hub, "pid-sami")
        values = []
        for k in range(1, 6):
            self.assertEqual((g.phase, g.k), ("clue", k))
            values.append(g.wall()["value"])
            self.assertEqual(len(g.wall()["clues"]), k)
            run_for(hub, g.LAST if k == 5 else g.CLUE)
        self.assertEqual(values, [5, 4, 3, 2, 1])
        self.assertEqual(g.phase, "reveal")
        self.assertIsNone(g.data["winner"])
        self.assertEqual(g.points, {})
        run_for(hub, g.REVEAL)
        self.assertEqual((g.phase, g.data["line"]), ("leads", "NO SCORES YET"))

    def test_buzz_and_right(self):
        hub = self.hub()
        join(hub, "pid-sami", "Sami")
        join(hub, "pid-omar", "Omar")
        g = start(hub, "pid-sami")
        run_for(hub, g.CLUE)  # clue 2: worth 4
        run_for(hub, 0.5)
        send(hub, "pid-sami", "buzz")
        send(hub, "pid-omar", "buzz")  # second to reach the Pi: ignored
        self.assertEqual((g.phase, g.buzzer), ("buzz", "pid-sami"))
        pad = g.pad("pid-sami")
        self.assertEqual(pad["ui"], "pick")
        self.assertEqual(sorted(o["label"] for o in pad["options"]), sorted([right(g)] + g.item()["decoys"]))
        self.assertEqual(g.pad("pid-omar")["ui"], "buzz")
        self.assertTrue(g.pad("pid-omar")["locked"])
        send(hub, "pid-omar", "pick", id=right(g))  # only the buzzer's pick counts
        self.assertEqual(g.phase, "buzz")
        send(hub, "pid-sami", "pick", id=right(g))
        self.assertEqual(g.phase, "reveal")
        self.assertEqual(g.points, {"pid-sami": 4})
        self.assertEqual(g.data["winner"]["name"], "SAMI")
        self.assertEqual(g.pad("pid-sami")["big"], "+4")
        run_for(hub, g.REVEAL)
        self.assertEqual((g.phase, g.data["line"]), ("leads", "SAMI LEADS"))
        self.assertEqual(g.pad("pid-sami")["big"], "1st")
        run_for(hub, g.LEADS)
        self.assertEqual((g.phase, g.c, g.k, g.out), ("clue", 1, 1, set()))

    def test_buzzes_on_a_stale_screen_are_ignored(self):
        hub = self.hub()
        join(hub, "pid-sami", "Sami")
        g = start(hub, "pid-sami")
        hub.clock.t = g.until
        hub.tick()  # clue 2 has just appeared
        self.assertEqual((g.k, g.at), (2, hub.clock.t))
        hub.clock.t += 0.2
        send(hub, "pid-sami", "buzz")
        self.assertEqual(g.phase, "clue")
        hub.clock.t += 0.15
        send(hub, "pid-sami", "buzz")
        self.assertEqual(g.phase, "buzz")

    def test_wrong_buzz_locks_out_and_the_clues_carry_on(self):
        hub = self.hub()
        join(hub, "pid-sami", "Sami")
        join(hub, "pid-omar", "Omar")
        g = start(hub, "pid-sami")
        run_for(hub, 2)
        send(hub, "pid-sami", "buzz")
        send(hub, "pid-sami", "pick", id=wrong(g))
        self.assertEqual((g.phase, g.data["wrong"]), ("miss", wrong(g)))
        self.assertEqual(g.pad("pid-sami")["big"], "Not it")
        run_for(hub, g.MISS)
        self.assertEqual((g.phase, g.k), ("clue", 1))
        self.assertAlmostEqual(g.until - g.at, g.CLUE - 2, delta=0.3)  # the clue's time left
        self.assertTrue(g.pad("pid-sami")["locked"])
        self.assertFalse(g.pad("pid-omar")["locked"])
        self.assertEqual({l["slot"]: l["locked"] for l in g.wall()["locks"]}, {0: False, 1: True})
        run_for(hub, 0.5)
        send(hub, "pid-sami", "buzz")  # locked out
        self.assertEqual(g.phase, "clue")
        send(hub, "pid-omar", "buzz")
        run_for(hub, g.PICK)  # too slow: that's a miss too
        self.assertEqual((g.phase, g.data["wrong"]), ("miss", None))
        run_for(hub, g.MISS)
        # everyone is out: the answer, and nobody scores
        self.assertEqual(g.phase, "reveal")
        self.assertIsNone(g.data["winner"])
        self.assertEqual(g.points, {})

    def test_the_wall_never_sees_the_answer_early(self):
        hub = self.hub()
        join(hub, "pid-sami", "Sami")
        join(hub, "pid-omar", "Omar")
        wall_q = hub.subscribe("display", None)
        g = start(hub, "pid-sami")
        it = g.item()
        run_for(hub, g.CLUE + 1)
        send(hub, "pid-sami", "buzz")
        send(hub, "pid-sami", "pick", id=wrong(g))
        self.assertIn(it["decoys"][0], json.dumps(g.wall()))  # the crossed-out pick does show
        run_for(hub, g.MISS + 1)
        walls = [m for m in iter_queue(wall_q) if '"phase"' in m]  # the game's views (not the roster)
        self.assertTrue(walls)
        for m in walls:
            self.assertEqual(json.loads(m)["type"], "party")  # the view never overwrites the message's type
            self.assertNotIn(it["answer"], m)
            self.assertNotIn(it["clues"][4], m)  # nor a clue before its time
            self.assertNotIn(it["decoys"][1], m)
        # phones never get the clues
        self.assertFalse(any(c in json.dumps(g.pad("pid-omar")) for c in it["clues"]))

    def test_a_whole_round_to_the_podium(self):
        hub = self.hub()
        join(hub, "pid-sami", "Sami")
        join(hub, "pid-layla", "Layla")
        g = start(hub, "pid-sami")
        for card in range(6):
            self.assertEqual((g.phase, g.c), ("clue", card))
            run_for(hub, 0.5)
            who = "pid-sami" if card % 2 else "pid-layla"
            send(hub, who, "buzz")
            send(hub, who, "pick", id=right(g))
            run_for(hub, g.REVEAL + (g.LEADS if card < 5 else 0))
        self.assertEqual(g.phase, "podium")
        self.assertEqual(g.points, {"pid-sami": 15, "pid-layla": 15})
        self.assertEqual(len(g.data["places"]), 2)
        self.assertEqual(g.pad("pid-sami")["ui"], "next")
        send(hub, "pid-layla", "next")
        self.assertEqual((g.phase, g.round), ("card", 2))
        self.assertEqual(g.night, {"pid-sami": 15, "pid-layla": 15})

    def test_sips(self):
        hub = self.hub(sips=True)
        join(hub, "pid-sami", "Sami", drinks=True)
        join(hub, "pid-omar", "Omar", drinks=False)
        join(hub, "pid-layla", "Layla", drinks=True)
        g = start(hub, "pid-sami")
        run_for(hub, 0.5)
        # a wrong buzz is a sip, but only for a drinker
        send(hub, "pid-omar", "buzz")
        send(hub, "pid-omar", "pick", id=wrong(g))
        self.assertEqual(g.drops, {})
        run_for(hub, g.MISS + 0.5)
        send(hub, "pid-sami", "buzz")
        send(hub, "pid-sami", "pick", id=wrong(g))
        self.assertIn("pid-sami", g.drops)
        self.assertEqual(g.pad("pid-sami")["notice"]["title"], "A SIP")
        wall = json.dumps(g.wall())
        self.assertNotIn("drinks", wall)
        self.assertEqual([p["name"] for p in g.wall()["players"] if p["drop"]], ["SAMI"])
        # right on the first clue: Layla may pour one out, only to another drinker
        run_for(hub, g.MISS + 0.5)
        send(hub, "pid-layla", "buzz")
        send(hub, "pid-layla", "pick", id=right(g))
        self.assertTrue(g.data["spot"])
        run_for(hub, 2)
        self.assertEqual([o["name"] for o in g.pad("pid-layla")["pour"]["options"]], ["SAMI"])
        # on the second clue, no pour
        run_for(hub, g.REVEAL + g.LEADS)
        run_for(hub, g.CLUE + 0.5)
        send(hub, "pid-sami", "buzz")
        send(hub, "pid-sami", "pick", id=right(g))
        self.assertFalse(g.data["spot"])
        run_for(hub, 2)
        self.assertNotIn("pour", g.pad("pid-sami"))

    def test_sips_off(self):
        hub = self.hub(sips=False)
        join(hub, "pid-sami", "Sami", drinks=True)
        join(hub, "pid-layla", "Layla", drinks=True)
        g = start(hub, "pid-sami")
        run_for(hub, 0.5)
        send(hub, "pid-sami", "buzz")
        send(hub, "pid-sami", "pick", id=wrong(g))
        self.assertEqual(g.drops, {})
        run_for(hub, g.MISS + 0.5)
        send(hub, "pid-layla", "buzz")
        send(hub, "pid-layla", "pick", id=right(g))
        run_for(hub, 2)
        self.assertNotIn("pour", g.pad("pid-layla"))

    def test_buzzer_leaving_is_a_miss(self):
        hub = self.hub()
        join(hub, "pid-sami", "Sami")
        join(hub, "pid-omar", "Omar")
        g = start(hub, "pid-sami")
        run_for(hub, 0.5)
        send(hub, "pid-sami", "buzz")
        hub.leave({"pid": "pid-sami"})
        run_for(hub, g.PICK + g.MISS)
        self.assertEqual(g.phase, "clue")
        run_for(hub, 0.5)
        send(hub, "pid-omar", "buzz")
        self.assertEqual(g.buzzer, "pid-omar")


if __name__ == "__main__":
    unittest.main()
