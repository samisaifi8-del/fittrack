#!/usr/bin/env python3
"""Tests for the Pi's health on the remote: reading the firmware's flags, what the remote is told,
and that it's only sent when something changes. Standard library only:  python3 test_health.py"""

import json
import os
import tempfile
import unittest

import server


class Throttled(unittest.TestCase):
    def test_flags(self):
        self.assertEqual(server.parse_throttled("throttled=0x50005\n"), 0x50005)
        self.assertEqual(server.parse_throttled("throttled=0x0"), 0)

    def test_not_a_pi(self):
        self.assertIsNone(server.parse_throttled(""))
        self.assertIsNone(server.parse_throttled("VCHI initialization failed"))
        self.assertIsNone(server.parse_throttled(None))


class Report(unittest.TestCase):
    def test_fine(self):
        self.assertEqual(server.health_report(52.4, 0), {"temp": 52, "heat": "ok", "power": "ok"})

    def test_heat(self):
        self.assertEqual(server.health_report(70.0, 0)["heat"], "warm")
        self.assertEqual(server.health_report(79.9, 0)["heat"], "warm")
        self.assertEqual(server.health_report(80.0, 0)["heat"], "hot")

    def test_power(self):
        self.assertEqual(server.health_report(50, 0x50005)["power"], "low")      # short of power now
        self.assertEqual(server.health_report(50, 0x50000)["power"], "dipped")   # earlier, not now
        self.assertEqual(server.health_report(50, 0x20000)["power"], "ok")       # capped by heat once, power fine

    def test_partial_and_none(self):
        self.assertEqual(server.health_report(None, 0), {"temp": None, "heat": None, "power": "ok"})
        self.assertEqual(server.health_report(61, None), {"temp": 61, "heat": "ok", "power": None})
        self.assertIsNone(server.health_report(None, None))


class Watch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = server.Store(self.tmp.name)
        self.zone = os.path.join(self.tmp.name, "temp")
        self.health = server.Health(self.store, thermal=self.zone, vcgencmd=None)
        self.store.health_info = self.health.info
        self.sent = 0
        refresh = self.store.refresh
        self.store.refresh = lambda: (setattr(self, "sent", self.sent + 1), refresh())

    def tearDown(self):
        self.tmp.cleanup()

    def set_temp(self, c):
        with open(self.zone, "w", encoding="ascii") as f:
            f.write(f"{int(c * 1000)}\n")

    def test_reads_the_kernel_and_sends_only_changes(self):
        self.set_temp(55.2)
        self.assertEqual(self.health.check(), {"temp": 55, "heat": "ok", "power": None})
        self.assertEqual(json.loads(self.store.snapshot())["health"]["temp"], 55)
        self.health.check()
        self.assertEqual(self.sent, 1)
        self.set_temp(81)
        self.assertEqual(self.health.check()["heat"], "hot")
        self.assertEqual(self.sent, 2)

    def test_nothing_to_read(self):
        self.assertIsNone(self.health.check())
        self.assertIsNone(json.loads(self.store.snapshot())["health"])
        self.assertEqual(self.sent, 0)


if __name__ == "__main__":
    unittest.main()
