#!/usr/bin/env python3
"""Tests for what the control page (static/control.html) asks the server for beyond the rest of
the API: the QR code of the games' join page for its Invite sheet. Standard library only:
python3 test_control.py"""

import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import server


class JoinLink(unittest.TestCase):
    def test_scheme_added(self):
        self.assertEqual(server.join_link("basement.local:8080/play"), "http://basement.local:8080/play")
        self.assertEqual(server.join_link("https://x.example/play"), "https://x.example/play")
        self.assertEqual(server.join_link(""), "")


class JoinQR(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        store = server.Store(self.tmp.name)
        self.saved = {k: getattr(server.Handler, k, None) for k in ("store", "hub")}
        self.saved_qr = server.qr_matrix
        server.Handler.store = store
        server.Handler.hub = server.GameHub(store)
        server.Handler.hub.join_url = "basement.local:8080/play"
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        server.qr_matrix = self.saved_qr
        for k, v in self.saved.items():
            setattr(server.Handler, k, v)
        self.tmp.cleanup()

    def test_svg_of_the_join_page(self):
        asked = []
        server.qr_matrix = lambda text: asked.append(text) or ["111", "101", "111"]
        with urllib.request.urlopen(self.base + "/api/game/qr.svg") as r:
            self.assertEqual(r.headers["Content-Type"], "image/svg+xml")
            self.assertTrue(r.read().startswith(b"<svg"))
        self.assertEqual(asked, ["http://basement.local:8080/play"])

    def test_no_qrencode(self):
        server.qr_matrix = lambda text: None
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(self.base + "/api/game/qr.svg")
        self.assertEqual(e.exception.code, 404)
        self.assertIn("error", json.loads(e.exception.read()))


if __name__ == "__main__":
    unittest.main()
