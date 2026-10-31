#!/usr/bin/env python3
"""Tests for Basement Live's server side: finding the tunnel's address, the tunnel gate and the
camera handshake. Standard library only:  python3 test_live.py"""

import json
import queue
import tempfile
import time
import unittest

import server

# What cloudflared prints when a quick tunnel comes up (as it appears in journalctl -o cat).
CLOUDFLARED_LOG = """\
2026-10-31T18:02:11Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out.
2026-10-31T18:02:11Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-10-31T18:02:13Z INF +--------------------------------------------------------------------------------------------+
2026-10-31T18:02:13Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-10-31T18:02:13Z INF |  https://seasonal-deck-organisms-sf.trycloudflare.com                                      |
2026-10-31T18:02:13Z INF +--------------------------------------------------------------------------------------------+
2026-10-31T18:02:13Z INF Version 2026.9.1
2026-10-31T18:02:14Z INF Registered tunnel connection connIndex=0 location=lhr01 protocol=quic
"""


class TunnelAddress(unittest.TestCase):
    def test_log_box(self):
        self.assertEqual(server.parse_tunnel_host(CLOUDFLARED_LOG), "seasonal-deck-organisms-sf.trycloudflare.com")

    def test_api_host_is_not_an_address(self):
        log = 'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": dial tcp: i/o timeout'
        self.assertEqual(server.parse_tunnel_host(log), "")

    def test_last_address_wins(self):
        log = "https://old-one-here.trycloudflare.com\n...\n|  https://New-One-There.trycloudflare.com  |"
        self.assertEqual(server.parse_tunnel_host(log), "new-one-there.trycloudflare.com")

    def test_lookalikes(self):
        for text in ["", "no address here", "https://trycloudflare.com", "http://a.example.com/x.trycloudflare.com",
                     "https://evil.trycloudflare.com.example.net"]:
            self.assertEqual(server.parse_tunnel_host(text), "", text)

    def test_metrics_endpoint(self):
        self.assertEqual(server.parse_quicktunnel(b'{"hostname":"quiet-velvet-lounge.trycloudflare.com"}'),
                         "quiet-velvet-lounge.trycloudflare.com")
        for body in [b'{"hostname":""}', b'{}', b'not json', b'[1]', b'{"hostname":"evil.example.com"}',
                     b'{"hostname":"x.trycloudflare.com\\"><b"}', b'{"hostname":"api.trycloudflare.com"}']:
            self.assertEqual(server.parse_quicktunnel(body), "", body)


class Gate(unittest.TestCase):
    def test_headers(self):
        self.assertTrue(server.via_tunnel({"Cf-Connecting-IP": "203.0.113.9"}))
        self.assertTrue(server.via_tunnel({"Cf-Ray": "8c1f-LHR"}))
        self.assertFalse(server.via_tunnel({}))

    def test_only_the_camera_page(self):
        allowed = {p for _, p in server.TUNNEL_ALLOWED}
        self.assertEqual(allowed, {"/live", "/api/live/poll", "/api/live/offer", "/api/live/leave"})


class FakeStore:
    def __init__(self):
        self.state = {"screens": [{"id": "s1", "enabled": True, "channel": "live", "pinned": None}],
                      "settings": {"barName": "THE BASEMENT"}}
        self.refreshed = 0

    def refresh(self):
        self.refreshed += 1


SDP = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n"


def drain(q):
    out = []
    while True:
        try:
            out.append(json.loads(q.get_nowait()))
        except queue.Empty:
            return out


class Handshake(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()
        self.hub = server.LiveHub(self.store)
        self.hub.POLL_WAIT = 0.05

    def test_offer_answer(self):
        display = self.hub.subscribe()
        self.assertEqual(drain(display)[0]["type"], "hello")
        res = self.hub.offer({"cid": "phone-aaaa1", "name": "  sami  ", "sdp": SDP})
        self.assertEqual(res["gen"], 1)
        (offer,) = drain(display)
        self.assertEqual((offer["type"], offer["name"], offer["slot"]), ("offer", "SAMI", 0))
        self.hub.answer({"cid": "phone-aaaa1", "gen": 1, "sdp": "v=0 answer"})
        got = self.hub.poll("phone-aaaa1", res["seq"], "")
        self.assertEqual(got["msgs"], [{"type": "answer", "gen": 1, "sdp": "v=0 answer"}])
        with self.assertRaises(server.ApiError):  # the same offer can't be answered twice
            self.hub.answer({"cid": "phone-aaaa1", "gen": 1, "sdp": "v=0 again"})

    def test_fifth_is_refused(self):
        for i in range(4):
            self.hub.offer({"cid": f"phone-{i:05d}", "name": f"p{i}", "sdp": SDP})
        with self.assertRaises(server.ApiError) as e:
            self.hub.offer({"cid": "phone-99999", "name": "five", "sdp": SDP})
        self.assertEqual(e.exception.status, 409)
        self.hub.offer({"cid": "phone-00002", "name": "p2", "sdp": SDP})  # a live phone can still re-offer
        self.hub.leave({"cid": "phone-00001"})
        self.hub.offer({"cid": "phone-99999", "name": "five", "sdp": SDP})
        self.assertEqual(self.hub.cams["phone-99999"]["slot"], 1)  # takes the free place

    def test_display_reload_asks_for_fresh_offers(self):
        first = self.hub.subscribe()
        res = self.hub.offer({"cid": "phone-aaaa1", "name": "a", "sdp": SDP})
        self.hub.answer({"cid": "phone-aaaa1", "gen": 1, "sdp": "v=0 answer"})
        self.hub.unsubscribe(first)
        second = self.hub.subscribe()
        hello = drain(second)[0]
        self.assertEqual([c["cid"] for c in hello["cams"]], ["phone-aaaa1"])
        msgs = self.hub.poll("phone-aaaa1", res["seq"], "")["msgs"]
        self.assertIn({"type": "reoffer"}, msgs)

    def test_waiting_offer_goes_to_a_new_display(self):
        self.hub.offer({"cid": "phone-aaaa1", "name": "a", "sdp": SDP})  # no display yet
        display = self.hub.subscribe()
        types = [m["type"] for m in drain(display)]
        self.assertEqual(types, ["hello", "offer"])

    def test_newer_display_takes_over(self):
        old = self.hub.subscribe()
        drain(old)
        self.hub.subscribe()
        self.assertEqual(drain(old), [{"type": "standby"}])

    def test_quiet_phone_is_dropped(self):
        display = self.hub.subscribe()
        self.hub.offer({"cid": "phone-aaaa1", "name": "a", "sdp": SDP})
        drain(display)
        self.hub.cams["phone-aaaa1"]["seen"] = time.time() - 60
        self.hub.prune()
        self.assertEqual(drain(display), [{"type": "leave", "cid": "phone-aaaa1"}])
        self.assertTrue(self.hub.poll("phone-aaaa1", 0, "")["gone"])

    def test_status_change_ends_a_poll(self):
        res = self.hub.offer({"cid": "phone-aaaa1", "name": "a", "sdp": SDP})
        key = res["status"]["key"]
        self.assertFalse(res["status"]["display"])
        self.hub.subscribe()
        got = self.hub.poll("phone-aaaa1", 10 ** 9, key)
        self.assertTrue(got["status"]["display"])
        self.store.state["screens"][0]["channel"] = "visuals"
        self.assertFalse(self.hub.poll("phone-aaaa1", 10 ** 9, got["status"]["key"])["status"]["onWall"])

    def test_bad_input(self):
        for body in [{"cid": "short", "sdp": SDP}, {"cid": "phone-aaaa1", "sdp": "nope"}, {"cid": "phone-aaaa1"},
                     {"cid": "phone-aaaa1", "sdp": "v=" + "x" * 30000}, {"cid": "../../etc", "sdp": SDP}]:
            with self.assertRaises(server.ApiError, msg=str(body)[:40]):
                self.hub.offer(body)


class QR(unittest.TestCase):
    def test_svg(self):
        rows = ["1" * 21] + ["1" + "0" * 19 + "1"] * 19 + ["1" * 21]
        svg = server.qr_svg(rows)
        self.assertTrue(svg.startswith("<svg") and 'viewBox="0 0 29 29"' in svg)

    def test_missing_tool(self):
        saved = server.QRENCODE
        server.QRENCODE = None
        try:
            self.assertIsNone(server.qr_matrix("https://x.trycloudflare.com/live"))
        finally:
            server.QRENCODE = saved


class Store(unittest.TestCase):
    def test_live_is_a_channel(self):
        with tempfile.TemporaryDirectory() as d:
            store = server.Store(d)
            store.update_screen("s1", {"channel": "live"})
            self.assertEqual(json.loads(store.snapshot())["live"]["s1"]["channel"], "live")


if __name__ == "__main__":
    unittest.main()
