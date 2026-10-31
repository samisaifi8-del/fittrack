#!/usr/bin/env python3
"""Tests that the Store, the game hub and The House Pour, wired together as main() wires them,
never wait on each other's locks: a game's call into the Store (Five Lights' tier, The Verdict's
guest prompts and host controls) runs once the hub's lock is let go. Standard library only:
python3 test_locks.py"""

import json
import tempfile
import threading
import unittest

import server
from test_party import join, make_hub, send


def wired(tmp, game):
    hub = make_hub(tmp, game)
    store = hub.store
    pour = server.HousePour(store)
    store.party_info = hub.host_info
    store.pour_info = pour.info
    pour.guest_names = lambda: hub.names()
    return hub, store


def within(test, fn, secs=3):
    """Runs fn on its own thread and fails the test if it hasn't returned in secs (a deadlock)."""
    out = {}

    def run():
        try:
            fn()
        except Exception as e:
            out["error"] = e
    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(secs)
    test.assertFalse(t.is_alive(), "deadlocked")
    if "error" in out:
        raise out["error"]


class Locks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def test_fivelights_tier_from_a_phone(self):
        hub, store = wired(self.tmp.name, "fivelights")
        q = hub.subscribe("display", None)
        join(hub, "pid-sami", "Sami")
        join(hub, "pid-layla", "Layla")
        within(self, lambda: send(hub, "pid-sami", "pick", id="dubai"))
        self.assertEqual(store.state["channels"]["games"]["tier"], "dubai")
        self.assertEqual(json.loads(store.snapshot())["bar"]["names"][:2], ["SAMI", "LAYLA"])
        # the wall heard about the new tier after the Store took it
        views = []
        while not q.empty():
            views.append(json.loads(q.get_nowait()))
        self.assertEqual([v for v in views if v["type"] == "party"][-1]["lines"][-1], "DUBAI LIFE PROMPTS")
        within(self, lambda: send(hub, "pid-layla", "start"))
        self.assertEqual(hub.party.phase, "card")

    def test_verdict_suggest_and_host(self):
        hub, store = wired(self.tmp.name, "verdict")
        for pid, name in (("pid-sami", "Sami"), ("pid-layla", "Layla"), ("pid-omar", "Omar")):
            join(hub, pid, name)
        within(self, lambda: send(hub, "pid-sami", "suggest", text="cry at a wedding"))
        waiting = json.loads(store.snapshot())["party"]["waiting"]
        self.assertEqual([w["text"] for w in waiting], ["CRY AT A WEDDING"])
        within(self, lambda: hub.host({"action": "approve", "id": waiting[0]["id"]}))
        self.assertEqual(json.loads(store.snapshot())["party"]["approved"], ["CRY AT A WEDDING"])
        within(self, lambda: hub.host({"action": "next"}))
        self.assertEqual(hub.party.phase, "vote")
        within(self, lambda: hub.host({"action": "next"}))  # skips the one on the wall
        self.assertEqual(json.loads(store.snapshot())["party"]["phase"], "vote")

    def test_racing_the_snapshot(self):
        hub, store = wired(self.tmp.name, "fivelights")
        join(hub, "pid-sami", "Sami")
        stop = threading.Event()

        def snapshots():
            while not stop.is_set():
                store.snapshot()
                stop.wait(0.001)  # like the wall's and phones' requests, not one tight loop

        def picks():
            for i in range(100):
                send(hub, "pid-sami", "pick", id=("mild", "dubai")[i % 2])
        t = threading.Thread(target=snapshots, daemon=True)
        t.start()
        try:
            within(self, picks, secs=20)
        finally:
            stop.set()
            t.join(2)


if __name__ == "__main__":
    unittest.main()
