#!/usr/bin/env python3
"""Tests for Now Showing's server side: reading Wikipedia's and Wikidata's answers, the film
cache (a rewatch works offline) and the night itself (countdown, intermission, THE END). No
network: the lookups are replaced with canned answers. Standard library only:
python3 test_nowshowing.py"""

import json
import os
import tempfile
import time
import unittest
from unittest import mock

import server

# What Wikipedia answers to a search for "godfather 2" (trimmed).
SEARCH = {"query": {"pages": [
    {"pageid": 2466773, "title": "The Godfather", "index": 3, "pageprops": {"wikibase_item": "Q47703"},
     "thumbnail": {"source": "https://upload.wikimedia.org/wikipedia/en/1/1c/Godfather_ver1.jpg", "width": 220, "height": 330},
     "description": "1972 film by Francis Ford Coppola"},
    {"pageid": 73875, "title": "The Godfather Part II", "index": 1, "pageprops": {"wikibase_item": "Q184768"},
     "thumbnail": {"source": "https://upload.wikimedia.org/wikipedia/en/0/03/Godfather_part_ii.jpg", "width": 220, "height": 331},
     "description": "1974 film by Francis Ford Coppola"},
    {"pageid": 15072865, "title": "The Godfather (film series)", "index": 2, "description": "1972–1990 film series directed by Francis Ford Coppola"},
    {"pageid": 1880546, "title": "The Godfather Saga", "index": 4, "description": "1977 television miniseries directed by Francis Ford Coppola"},
    {"pageid": 999, "title": "Heat (1995 film)", "index": 5, "description": "1995 crime drama film by Michael Mann",
     "thumbnail": {"source": "https://upload.wikimedia.org/wikipedia/en/6/6c/Heat_still.jpg", "width": 300, "height": 200}},
]}}

CLAIMS = {"claims": {
    "P577": [{"mainsnak": {"datavalue": {"value": {"time": "+1975-07-28T00:00:00Z"}}}},
             {"mainsnak": {"datavalue": {"value": {"time": "+1974-12-12T00:00:00Z"}}}}],
    "P2047": [{"rank": "normal", "mainsnak": {"datavalue": {"value": {"amount": "+202", "unit": "http://www.wikidata.org/entity/Q7727"}}}},
              {"rank": "preferred", "mainsnak": {"datavalue": {"value": {"amount": "+200", "unit": "http://www.wikidata.org/entity/Q7727"}}}}],
}}

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64


def fake_fetch(url, timeout=8, ua=None):
    """Stands in for the network: Wikipedia, Wikidata and the poster."""
    if "wikipedia.org/w/api.php" in url:
        if "pageids=999" in url:
            return json.dumps({"query": {"pages": [SEARCH["query"]["pages"][4]]}}).encode()
        if "pageids=73875" in url:
            return json.dumps({"query": {"pages": [SEARCH["query"]["pages"][1]]}}).encode()
        return json.dumps(SEARCH).encode()
    if "wikidata.org" in url:
        prop = "P577" if "P577" in url else "P2047"
        return json.dumps({"claims": {prop: CLAIMS["claims"][prop]}}).encode()
    if url.startswith("https://upload.wikimedia.org/"):
        return JPEG
    raise AssertionError("unexpected fetch: " + url)


def offline(url, timeout=8, ua=None):
    raise OSError("no network")


class Parsing(unittest.TestCase):
    def test_titles(self):
        self.assertEqual(server.film_title("Heat (1995 film)"), "Heat")
        self.assertEqual(server.film_title("Dune (2021 film)"), "Dune")
        self.assertEqual(server.film_title("Amélie"), "Amélie")
        self.assertEqual(server.film_title("Paris, Texas (film)"), "Paris, Texas")
        self.assertEqual(server.film_title("Love (Gaspar Noé album)"), "Love (Gaspar Noé album)")

    def test_director(self):
        self.assertEqual(server.film_director("1974 film by Francis Ford Coppola"), "Francis Ford Coppola")
        self.assertEqual(server.film_director("1995 crime drama film by Michael Mann"), "Michael Mann")
        self.assertEqual(server.film_director("1986 film by Dick Richards, Jerry Jameson"), "")
        self.assertEqual(server.film_director("2013 French film"), "")

    def test_search_order_and_films_only(self):
        films = server.parse_film_pages(SEARCH)
        self.assertEqual([f["title"] for f in films], ["The Godfather Part II", "The Godfather", "Heat"])
        first = films[0]
        self.assertEqual((first["key"], first["year"], first["qid"], first["director"]), ("73875", 1974, "Q184768", "Francis Ford Coppola"))

    def test_claims(self):
        self.assertEqual(server.parse_film_claims(CLAIMS), {"year": 1974, "runtime": 200})
        hours = {"claims": {"P2047": [{"mainsnak": {"datavalue": {"value": {"amount": "+2.5", "unit": "http://www.wikidata.org/entity/Q25235"}}}}]}}
        self.assertEqual(server.parse_film_claims(hours)["runtime"], 150)
        self.assertEqual(server.parse_film_claims({}), {"year": None, "runtime": None})
        silly = {"claims": {"P2047": [{"mainsnak": {"datavalue": {"value": {"amount": "+9000", "unit": "http://www.wikidata.org/entity/Q7727"}}}}]}}
        self.assertIsNone(server.parse_film_claims(silly)["runtime"])

    def test_image_types(self):
        self.assertEqual(server.image_ext(JPEG), ".jpg")
        self.assertEqual(server.image_ext(b"\x89PNG\r\n\x1a\n...."), ".png")
        self.assertIsNone(server.image_ext(b"<!doctype html>"))


class Night(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.store = server.Store(self.dir)
        self.cinema = server.Cinema(self.store)

    def choose(self, key="73875"):
        with mock.patch.object(server, "fetch_url", fake_fetch):
            return self.cinema.choose({"key": key})

    def test_choose_caches_poster_and_details(self):
        film = self.choose()
        self.assertEqual(film, {"key": "73875", "title": "The Godfather Part II", "year": 1974, "runtime": 200,
                                "director": "Francis Ford Coppola", "poster": "/films/73875.jpg"})
        with open(os.path.join(self.dir, "films", "73875.jpg"), "rb") as f:
            self.assertEqual(f.read(), JPEG)
        self.assertEqual(self.store.state["cinema"]["phase"], "poster")
        self.assertEqual(self.store.state["screens"][0]["channel"], "nowshowing")
        self.assertEqual(json.loads(self.store.snapshot())["cinema"]["film"]["title"], "The Godfather Part II")

    def test_still_is_not_a_poster(self):
        film = self.choose("999")
        self.assertEqual((film["title"], film["poster"]), ("Heat", ""))

    def test_rewatch_offline(self):
        self.choose()
        cinema = server.Cinema(server.Store(self.dir))  # the Pi restarted, and the internet is down
        with mock.patch.object(server, "fetch_url", offline):
            found = cinema.search("godfather")
            self.assertTrue(found["offline"])
            self.assertEqual([(r["key"], r["cached"]) for r in found["results"]], [("73875", True)])
            film = cinema.choose({"key": "73875"})
        self.assertEqual(film["poster"], "/films/73875.jpg")
        with mock.patch.object(server, "fetch_url", offline):
            with self.assertRaises(server.ApiError) as e:
                cinema.search("casablanca")
        self.assertEqual(e.exception.status, 502)

    def test_search_marks_films_shown_before(self):
        self.choose()
        with mock.patch.object(server, "fetch_url", fake_fetch):
            found = self.cinema.search("godfather 2")["results"]
        self.assertEqual([(r["title"], r["cached"]) for r in found], [("The Godfather Part II", True), ("The Godfather", False), ("Heat", False)])
        self.assertEqual(found[0]["poster"], "/films/73875.jpg")
        self.assertTrue(found[1]["poster"].startswith("https://upload.wikimedia.org/"))

    def test_bad_requests(self):
        for key in (None, "", "12a", "../x", 73875):
            with self.assertRaises(server.ApiError):
                self.cinema.choose({"key": key})
        with self.assertRaises(server.ApiError):
            self.cinema.start()  # no film yet
        self.choose()
        for mins in (0, 7, "5", True, None):
            self.store.state["cinema"]["phase"] = "film"
            with self.assertRaises(server.ApiError):
                self.cinema.intermission({"mins": mins})

    def test_the_night(self):
        self.choose()
        c = self.store.state["cinema"]
        with self.assertRaises(server.ApiError):
            self.cinema.intermission({"mins": 10})  # nothing running yet
        self.cinema.start()
        self.assertEqual(c["phase"], "countdown")
        self.assertAlmostEqual(c["until"] - c["at"], server.COUNTDOWN, delta=0.5)
        with self.assertRaises(server.ApiError):
            self.cinema.choose({"key": "73875"})  # no swapping films mid-film
        self.assertFalse(self.cinema.tick(c["until"] + 1))  # the curtains are still closing
        self.assertTrue(self.cinema.tick(c["until"] + server.DIM_DOWN))
        self.assertEqual(c["phase"], "film")
        # an intermission from anyone's phone, which ends by itself
        self.store.state["screens"][0]["channel"] = "scores"  # someone flicked over mid-film
        self.cinema.intermission({"mins": 10})
        self.assertEqual((c["phase"], c["mins"]), ("intermission", 10))
        self.assertEqual(self.store.state["screens"][0]["channel"], "nowshowing")
        self.assertAlmostEqual(c["until"] - time.time(), 600, delta=1)
        self.assertFalse(self.cinema.tick(c["until"] - 1))
        self.assertTrue(self.cinema.tick(c["until"]))
        self.assertEqual(c["phase"], "film")
        # or one cut short
        self.cinema.intermission({"mins": 5})
        self.cinema.resume()
        self.assertEqual(c["phase"], "film")
        with self.assertRaises(server.ApiError):
            self.cinema.resume()
        # THE END, then back to The Bar
        self.cinema.end()
        self.assertEqual(c["phase"], "end")
        self.assertFalse(self.cinema.tick(c["until"] - 1))
        self.assertTrue(self.cinema.tick(c["until"]))
        self.assertEqual(c["phase"], "poster")
        self.assertEqual(self.store.state["screens"][0]["channel"], "rotation")
        self.assertEqual(c["film"], "73875")  # still chosen, for a rewatch

    def test_saved_across_a_restart(self):
        self.choose()
        self.cinema.start()
        until = self.store.state["cinema"]["until"]
        store = server.Store(self.dir)
        self.assertEqual(store.state["cinema"]["phase"], "countdown")
        self.assertEqual(store.state["cinema"]["until"], until)

    def test_broken_saved_state(self):
        with open(os.path.join(self.dir, "state.json"), "w") as f:
            json.dump({"cinema": {"film": "../../etc", "phase": "film", "at": "x"}}, f)
        self.assertEqual(server.Store(self.dir).state["cinema"]["phase"], "idle")
        with open(os.path.join(self.dir, "state.json"), "w") as f:
            json.dump({"cinema": {"film": "1", "phase": "nonsense"}}, f)
        self.assertEqual(server.Store(self.dir).state["cinema"], server.default_cinema())


if __name__ == "__main__":
    unittest.main()
