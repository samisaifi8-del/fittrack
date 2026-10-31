#!/usr/bin/env python3
"""Tests for The House Pour's server side: the seeded drinks, tonight's menu, the order on the wall
and guests asking from their phones. Standard library only:  python3 test_pour.py"""

import json
import os
import tempfile
import time
import unittest

import server


def fresh():
    tmp = tempfile.TemporaryDirectory()
    store = server.Store(tmp.name)
    pour = server.HousePour(store)
    store.pour_info = pour.info
    return tmp, store, pour


class Drinks(unittest.TestCase):
    def test_seeded_file(self):
        drinks = server.load_drinks(server.DRINKS_FILE)
        self.assertEqual(len(drinks), 26)
        for d in drinks:
            self.assertIn(d["glass"], server.GLASSES)
            self.assertIn(d["garnish"], server.GARNISHES)
            self.assertRegex(d["colour"], r"^#[0-9a-f]{6}$")
        self.assertTrue(any(not d["alcohol"] for d in drinks))
        self.assertTrue(set(server.TONIGHT) <= {d["id"] for d in drinks})

    def test_bad_entries_are_left_out(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "drinks.json")
            good = {"id": "d001", "name": "negroni", "glass": "rocks", "colour": "#B3202A", "colour2": None}
            with open(path, "w") as f:
                json.dump([good, good, "nope", {"id": "d002", "name": "X", "glass": "bucket", "colour": "#000000"},
                           {"id": "x9", "name": "X", "glass": "rocks", "colour": "#000000"},
                           {"id": "d003", "name": "Y", "glass": "rocks", "colour": "red"}], f)
            drinks = server.load_drinks(path)
            self.assertEqual([d["id"] for d in drinks], ["d001"])
            self.assertEqual(drinks[0]["name"], "NEGRONI")
            self.assertEqual(drinks[0]["colour"], "#b3202a")
            self.assertEqual(server.load_drinks(os.path.join(tmp, "missing.json")), [])


class Menu(unittest.TestCase):
    def setUp(self):
        self.tmp, self.store, self.pour = fresh()

    def tearDown(self):
        self.tmp.cleanup()

    def test_default_menu(self):
        self.assertEqual([d["id"] for d in self.pour.menu()], server.TONIGHT)
        self.assertFalse(self.store.state["channels"]["pour"]["guestOrders"])

    def test_tonight_is_cleaned(self):
        conf = self.pour.update({"tonight": ["d005", "d005", "nope", 7, "d001"]})
        self.assertEqual(conf["tonight"], ["d005", "d001"])
        with self.assertRaises(server.ApiError):
            self.pour.update({"tonight": "d001"})
        with self.assertRaises(server.ApiError):
            self.pour.update({"guestOrders": "yes"})

    def test_saved_and_reloaded(self):
        self.pour.update({"tonight": ["d010"], "guestOrders": True})
        again = server.Store(self.tmp.name)
        self.assertEqual(again.state["channels"]["pour"]["tonight"], ["d010"])
        self.assertTrue(again.state["channels"]["pour"]["guestOrders"])

    def test_own_drinks(self):
        d = self.pour.add_drink({"name": "  house   sour ", "glass": "coupe", "colour": "#E3A63A"})
        self.assertEqual(d["name"], "HOUSE SOUR")
        self.assertEqual(d["colour"], "#e3a63a")
        self.assertIn(d["id"], self.store.state["channels"]["pour"]["tonight"])
        self.assertEqual(self.pour.menu()[-1]["name"], "HOUSE SOUR")
        for bad in [{"name": "", "glass": "coupe", "colour": "#000000"}, {"name": "A", "glass": "boot", "colour": "#000000"},
                    {"name": "A", "glass": "coupe"}, {"name": "A", "glass": "coupe", "colour": "orange"}]:
            with self.assertRaises(server.ApiError, msg=bad):
                self.pour.add_drink(bad)
        self.pour.remove_drink(d["id"])
        self.assertNotIn(d["id"], self.store.state["channels"]["pour"]["tonight"])
        with self.assertRaises(server.ApiError):
            self.pour.remove_drink("d001")  # the seeded ones stay

    def test_own_drinks_have_a_limit(self):
        for i in range(server.HousePour.MAX_CUSTOM):
            self.pour.add_drink({"name": f"D{i}", "glass": "rocks", "colour": "#112233"})
        with self.assertRaises(server.ApiError) as e:
            self.pour.add_drink({"name": "ONE MORE", "glass": "rocks", "colour": "#112233"})
        self.assertEqual(e.exception.status, 409)


class Order(unittest.TestCase):
    def setUp(self):
        self.tmp, self.store, self.pour = fresh()
        s1, s2 = self.store.state["screens"]
        s1.update(channel="scores")
        s2.update(enabled=True, channel="games")

    def tearDown(self):
        self.tmp.cleanup()

    def channels(self):
        return [s["channel"] for s in self.store.state["screens"]]

    def test_put_up_takes_over_quiet_walls_only(self):
        order = self.pour.put_up({"guest": " sarah ", "drink": "d001"})
        self.assertEqual(order["guest"], "SARAH")
        self.assertEqual(order["phase"], "making")
        self.assertEqual(order["drink"]["name"], "NEGRONI")
        self.assertEqual(self.channels(), ["pour", "games"])  # a game in progress is left alone
        self.pour.clear()
        self.assertIsNone(self.pour.order)
        self.assertEqual(self.channels(), ["scores", "games"])

    def test_pinned_wall_is_left_alone(self):
        self.store.state["screens"][0]["pinned"] = "abc"
        self.pour.put_up({"drink": "d001"})
        self.assertEqual(self.channels(), ["scores", "games"])

    def test_a_wall_changed_meanwhile_stays_changed(self):
        self.pour.put_up({"drink": "d001"})
        self.store.state["screens"][0]["channel"] = "news"
        self.pour.clear()
        self.assertEqual(self.channels(), ["news", "games"])

    def test_a_second_order_replaces_the_first_and_still_returns(self):
        self.pour.put_up({"guest": "A", "drink": "d001"})
        self.pour.put_up({"guest": "B", "drink": "d002"})
        self.assertEqual(self.pour.order["guest"], "B")
        self.pour.clear()
        self.assertEqual(self.channels(), ["scores", "games"])

    def test_served_comes_down_by_itself(self):
        self.pour.put_up({"guest": "Sarah", "drink": "d001"})
        self.pour.served()
        self.assertEqual(self.pour.order["phase"], "served")
        self.pour.tick()
        self.assertIsNotNone(self.pour.order)
        self.pour.order["at"] -= server.HousePour.SERVED_HOLD + 1
        self.pour.tick()
        self.assertIsNone(self.pour.order)
        self.assertEqual(self.channels(), ["scores", "games"])

    def test_a_restart_mid_order_puts_the_walls_back(self):
        self.pour.put_up({"guest": "Sara", "drink": "d001"})
        self.assertEqual(self.channels(), ["pour", "games"])
        store = server.Store(self.tmp.name)  # the Pi restarts: the order was only in memory
        server.HousePour(store)
        self.assertEqual([s["channel"] for s in store.state["screens"]], ["scores", "games"])
        self.assertEqual(store.state["channels"]["pour"]["returns"], {})
        # a wall tuned to 10 by hand stays on it
        store.update_screen("s1", {"channel": "pour"})
        server.HousePour(server.Store(self.tmp.name))
        self.assertEqual(server.Store(self.tmp.name).state["screens"][0]["channel"], "pour")

    def test_forgotten_order_comes_down(self):
        self.pour.put_up({"drink": "d001"})
        self.pour.order["at"] -= server.HousePour.MAKING_MAX + 1
        self.pour.tick()
        self.assertIsNone(self.pour.order)

    def test_unknown_drink(self):
        with self.assertRaises(server.ApiError) as e:
            self.pour.put_up({"drink": "d999"})
        self.assertEqual(e.exception.status, 404)
        with self.assertRaises(server.ApiError):
            self.pour.served()

    def test_snapshot(self):
        self.pour.put_up({"guest": "Sarah", "drink": "d004"})
        snap = json.loads(self.store.snapshot())
        self.assertEqual(snap["bar"]["order"]["drink"]["id"], "d004")
        self.assertNotIn("pid", snap["bar"]["order"])
        self.assertEqual(snap["bar"]["names"], ["SARAH"])
        self.assertEqual(len(snap["catalog"]["drinks"]), 26)
        self.assertEqual(snap["catalog"]["glasses"], server.GLASSES)

    def test_names_include_guests_on_their_phones(self):
        self.pour.guest_names = lambda: ["MO", "SARAH"]
        self.pour.put_up({"guest": "Sarah", "drink": "d001"})
        self.assertEqual(self.pour.info()["names"], ["SARAH", "MO"])


class Requests(unittest.TestCase):
    def setUp(self):
        self.tmp, self.store, self.pour = fresh()

    def tearDown(self):
        self.tmp.cleanup()

    def ask(self, pid="phone-one", drink="d001", name="sarah"):
        return self.pour.request({"pid": pid, "name": name, "drink": drink})

    def test_off_by_default(self):
        with self.assertRaises(server.ApiError) as e:
            self.ask()
        self.assertEqual(e.exception.status, 403)
        self.assertEqual(self.pour.guest("phone-one"), {"on": False, "menu": [], "mine": None})

    def test_ask_and_approve(self):
        self.pour.update({"guestOrders": True})
        self.assertEqual(self.ask()["state"], "asked")
        reqs = self.pour.info()["requests"]
        self.assertEqual(reqs[0]["name"], "SARAH")
        self.assertNotIn("pid", reqs[0])
        self.pour.approve({"rid": reqs[0]["rid"]})
        self.assertEqual(self.pour.order["guest"], "SARAH")
        self.assertEqual(self.pour.guest("phone-one")["mine"]["state"], "making")
        self.pour.served()
        self.assertEqual(self.pour.guest("phone-one")["mine"]["state"], "served")
        self.assertEqual(self.pour.info()["requests"], [])

    def test_decline(self):
        self.pour.update({"guestOrders": True})
        self.ask()
        self.pour.decline({"rid": self.pour.requests[0]["rid"]})
        self.assertEqual(self.pour.guest("phone-one")["mine"]["state"], "passed")
        self.assertIsNone(self.pour.order)
        with self.assertRaises(server.ApiError):
            self.pour.approve({"rid": "gone"})

    def test_one_request_per_phone_and_cancel(self):
        self.pour.update({"guestOrders": True})
        self.ask(drink="d001")
        self.ask(drink="d002")
        self.assertEqual([r["drink"]["id"] for r in self.pour.requests], ["d002"])
        self.pour.cancel({"pid": "phone-one"})
        self.assertEqual(self.pour.requests, [])
        self.assertIsNone(self.pour.guest("phone-one")["mine"])

    def test_only_from_tonights_menu(self):
        self.pour.update({"guestOrders": True, "tonight": ["d001"]})
        with self.assertRaises(server.ApiError) as e:
            self.ask(drink="d002")
        self.assertEqual(e.exception.status, 404)
        self.assertEqual([d["id"] for d in self.pour.guest("x-phone")["menu"]], ["d001"])

    def test_needs_a_name_and_a_good_id(self):
        self.pour.update({"guestOrders": True})
        with self.assertRaises(server.ApiError):
            self.ask(name="   ")
        with self.assertRaises(server.ApiError):
            self.ask(pid="no")

    def test_switching_off_drops_requests(self):
        self.pour.update({"guestOrders": True})
        self.ask()
        self.pour.update({"guestOrders": False})
        self.assertEqual(self.pour.requests, [])

    def test_taking_a_drink_off_the_menu_drops_its_requests(self):
        self.pour.update({"guestOrders": True})
        self.ask(drink="d001")
        self.pour.update({"tonight": ["d002"]})
        self.assertEqual(self.pour.requests, [])

    def test_a_busy_bar(self):
        self.pour.update({"guestOrders": True})
        for i in range(server.HousePour.MAX_REQUESTS):
            self.ask(pid=f"phone-{i:02d}")
        with self.assertRaises(server.ApiError) as e:
            self.ask(pid="phone-late")
        self.assertEqual(e.exception.status, 409)


if __name__ == "__main__":
    unittest.main()
