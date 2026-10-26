import socket
import threading
import unittest

from helpers import FakeRunner, example_site, me
from cflex_install import verify


def one_shot_server(reply, wait_for_request=True):
    """127.0.0.1:<port> that answers the first connection with `reply` and closes.
    wait_for_request=False: server speaks first (SMTP banner semantics)."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(1)

    def serve():
        c, _ = s.accept()
        if wait_for_request:
            try:
                c.recv(4096)
            except socket.error:
                pass
        c.sendall(reply)
        c.close()
        s.close()
    threading.Thread(target=serve, daemon=True).start()
    return s.getsockname()[1]


class Verify(unittest.TestCase):
    def test_proxy_auth_is_never_printed(self):
        url = "http://svc-cflex:s3cret@proxy.haea.local:3128"
        self.assertEqual(verify.redact(url), "proxy.haea.local:3128 (auth)")
        self.assertEqual(verify._parse_proxy(url)["auth"], "svc-cflex:s3cret")
        self.assertIsNone(verify._parse_proxy("http://<haea-proxy>:<port>"))

    def test_proxy_refusal_is_reported(self):
        port = one_shot_server(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
        good, detail = verify.tls("cflex.fms.support", 443, proxy={"host": "127.0.0.1", "port": port, "auth": "u:p"}, timeout=3)
        self.assertFalse(good)
        self.assertIn("407", detail)
        self.assertNotIn("u:p", detail)

    def test_smtp_banner(self):
        port = one_shot_server(b"220 relay.haea.local ESMTP\r\n", wait_for_request=False)
        good, detail = verify.tcp("127.0.0.1", port, timeout=3, banner=True)
        self.assertTrue(good, detail)

    def test_collector_checks_with_fake_network(self):
        site = example_site()
        calls = []
        fake = {"tcp": lambda h, p, **k: (calls.append(("tcp", h, p)) or (True, "ok")),
                "tls": lambda h, p=443, **k: (calls.append(("tls", h, p)) or (True, "ok"))}
        res = verify.run(site, "collector", me(site, "collector", "cap01"), "container", FakeRunner(),
                         as_cflex=lambda argv, mutating=True: (0, "", ""), connect=fake)
        names = [r.name for r in res]
        self.assertIn("service cflex-collector", names)
        self.assertIn("collector → app01 443", names)
        # D-13: a collector has no Portal path — not checked, not dialled.
        self.assertFalse(any("portal" in n for n in names), names)
        self.assertNotIn(("tls", "cflex.fms.support", 443), calls)
        self.assertFalse(any(h.startswith("<") for _, h, _ in calls if h))
        # Q-2026-10-25-10 (A): the collector does not notify — no SMTP/ServiceNow/Teams check, said so.
        self.assertFalse(any(n in r.name for r in res for n in ("SMTP relay", "ServiceNow", "Teams")))
        na = [r for r in res if "알림" in r.name]
        self.assertEqual(len(na), 1)
        self.assertIn("해당 없음", na[0].detail)

    def test_app_checks_notification_paths_and_sends_the_test_ticket_from_the_console(self):
        site = example_site()
        fake = {"tcp": lambda h, p, **k: (True, "ok"), "tls": lambda h, p=443, **k: (True, "ok")}
        ran = []
        res = verify.run(site, "app", me(site, "app", "app01"), "container", FakeRunner(),
                         as_cflex=lambda argv, mutating=True: (ran.append(argv) or (0, "OK  ServiceNow test ticket INC0010001", "")),
                         send_test=True, connect=fake)
        # Placeholders in the example (<relay>, <endpoint>) are reported, not dialled.
        self.assertEqual({r.verdict for r in res if "SMTP" in r.name}, {"WARN"})
        self.assertIn(["podman", "exec", "cflex-console", "node", "/opt/cflex/apps/console/src/cli.js", "test-ticket"], ran)
        self.assertEqual([r.verdict for r in res if r.name.startswith("send-test")], ["PASS"])
        self.assertIn("app → portal cflex.fms.support", [r.name for r in res], "D-13: the app node reaches the Portal")
        col = verify.run(site, "collector", me(site, "collector", "cap01"), "container", FakeRunner(),
                         as_cflex=lambda argv, mutating=True: (0, "", ""), send_test=True, connect=fake)
        self.assertEqual([r.verdict for r in col if r.name == "send-test"], ["WARN"], "the collector has no test ticket to send")


if __name__ == "__main__":
    unittest.main()
