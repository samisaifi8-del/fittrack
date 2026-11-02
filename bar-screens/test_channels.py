#!/usr/bin/env python3
"""Tests for the channel line-up once every feature is in: eleven channels, and Colours (9) and The
Verdict (11) as party games with channels of their own, kept in step with the game that's picked.
Standard library only:  python3 test_channels.py"""

import tempfile
import unittest

import partygames
import server


class LineUp(unittest.TestCase):
    def test_numbering(self):
        # the remote's numbers are the order of CHANNELS, 1 to 11
        self.assertEqual(server.CHANNELS, ["rotation", "scores", "news", "weather", "visuals", "games", "live",
                                           "nowshowing", "colours", "pour", "verdict"])

    def test_every_game_is_refereed_or_on_the_wall(self):
        keys = [g[0] for g in server.GAMES]
        self.assertEqual(len(keys), len(set(keys)))
        for key in ("closest", "fiveclues", "fivelights", "verdict", "colours"):
            self.assertIn(key, partygames.PARTY_GAMES)
            self.assertIn(key, keys)
        for key in server.GAME_CHANNELS:
            self.assertIn(key, server.CHANNELS)
            self.assertIn(key, partygames.PARTY_GAMES)


class GameChannels(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = server.Store(self.tmp.name)
        self.games = self.store.state["channels"]["games"]

    def tearDown(self):
        self.tmp.cleanup()

    def channel(self, sid="s1"):
        return self.store._screen(sid)["channel"]

    def test_tuning_to_the_verdict_picks_it(self):
        self.store.update_channels({"games": {"game": "fiveclues"}})
        self.store.update_screen("s1", {"channel": "verdict"})
        self.assertEqual(self.games["game"], "verdict")
        self.assertEqual(self.store.live["s1"]["channel"], "verdict")

    def test_games_goes_back_to_the_last_game(self):
        self.store.update_channels({"games": {"game": "fivelights"}})
        self.store.update_screen("s1", {"channel": "verdict"})
        self.store.update_screen("s1", {"channel": "colours"})
        self.store.update_screen("s1", {"channel": "games"})
        self.assertEqual(self.games["game"], "fivelights")
        self.assertEqual(self.channel(), "games")

    def test_picking_a_game_moves_a_game_wall(self):
        self.store.update_screen("s1", {"channel": "games"})
        self.store.update_channels({"games": {"game": "verdict"}})  # e.g. from a phone's lobby
        self.assertEqual(self.channel(), "verdict")
        self.assertEqual(self.games["back"], "breaker")  # what 6 goes back to
        self.store.update_channels({"games": {"game": "closest"}})
        self.assertEqual(self.channel(), "games")

    def test_other_channels_stay_put(self):
        self.store.update_screen("s1", {"channel": "visuals"})
        self.store.update_channels({"games": {"game": "verdict"}})
        self.assertEqual(self.channel(), "visuals")
        self.store.update_screen("s1", {"channel": "pour"})
        self.assertEqual(self.games["game"], "verdict")
        self.assertEqual(self.channel(), "pour")

    def test_both_walls_follow(self):
        self.store.update_screen("s2", {"enabled": True, "channel": "games"})
        self.store.update_screen("s1", {"channel": "colours"})
        self.assertEqual(self.channel("s2"), "colours")

    def test_back_survives_a_restart(self):
        self.store.update_channels({"games": {"game": "fiveclues"}})
        self.store.update_screen("s1", {"channel": "verdict"})
        again = server.Store(self.tmp.name)
        self.assertEqual(again.state["channels"]["games"]["game"], "verdict")
        self.assertEqual(again.state["channels"]["games"]["back"], "fiveclues")
        self.assertEqual(again._screen("s1")["channel"], "verdict")


class ScoresDetail(unittest.TestCase):
    """Scores' hero match: goals and red cards per side from ESPN's details, and crests via the Pi."""

    COMP = {
        "competitors": [{"homeAway": "home", "team": {"id": "359", "abbreviation": "ARS", "logo": "https://a.espncdn.com/i/teamlogos/soccer/500/359.png"}},
                        {"homeAway": "away", "team": {"id": "364", "abbreviation": "LIV", "logo": "http://evil.example/x.png"}}],
        "details": [
            {"type": {"text": "Goal"}, "clock": {"displayValue": "16'"}, "team": {"id": "359"}, "scoringPlay": True, "athletesInvolved": [{"shortName": "K. Havertz"}]},
            {"type": {"text": "Yellow Card"}, "clock": {"displayValue": "45'+2'"}, "team": {"id": "364"}, "yellowCard": True, "athletesInvolved": [{"shortName": "B. Barcola"}]},
            {"type": {"text": "Penalty - Scored"}, "clock": {"displayValue": "34'"}, "team": {"id": "364"}, "scoringPlay": True, "penaltyKick": True, "athletesInvolved": [{"athlete": {"shortName": "M. Salah"}}]},
            {"type": {"text": "Own Goal"}, "clock": {"displayValue": "70'"}, "team": {"id": "359"}, "scoringPlay": True, "ownGoal": True, "athletesInvolved": []},
            {"type": {"text": "Red Card"}, "clock": {"displayValue": "61'"}, "team": {"id": "364"}, "redCard": True, "athletesInvolved": [{"shortName": "V. van Dijk"}]},
            {"type": {"text": "Goal"}, "team": {"id": "999"}, "scoringPlay": True},
        ],
    }

    def test_events(self):
        sides = {c["homeAway"]: c for c in self.COMP["competitors"]}
        self.assertEqual(server._match_events(self.COMP, sides), [
            {"side": "home", "min": "16'", "who": "K. Havertz", "kind": "goal"},
            {"side": "away", "min": "34'", "who": "M. Salah", "kind": "pen"},
            {"side": "home", "min": "70'", "who": "", "kind": "og"},
            {"side": "away", "min": "61'", "who": "V. van Dijk", "kind": "red"},
        ])

    def test_crests_only_from_espn(self):
        home, away = (server._team(c) for c in self.COMP["competitors"])
        self.assertEqual(home["logo"], "https://a.espncdn.com/i/teamlogos/soccer/500/359.png")
        self.assertIsNone(away["logo"])
        with tempfile.TemporaryDirectory() as d:
            for bad in ("http://evil.example/x.png", "https://a.espncdn.com/../../etc/passwd", "file:///etc/passwd", None):
                self.assertIsNone(server.crest_file(d, bad))


if __name__ == "__main__":
    unittest.main()
