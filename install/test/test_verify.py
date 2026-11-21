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

    def test_portal_check_uses_the_senders_trust_and_identity(self):
        site = example_site()
        seen = []
        fake = {"tcp": lambda h, p, **k: (True, "ok"), "tls": lambda h, p=443, **k: (seen.append((h, k)) or (True, "ok"))}
        C = "/opt/app/cflex/certs/"
        files = {C + "device.pem": "", C + "device.key": "", C + "portal-ca.pem": ""}
        verify.run(site, "app", me(site, "app", "app01"), "container", FakeRunner(files=files),
                   as_cflex=lambda argv, mutating=True: (0, "", ""), connect=fake)
        k = dict(seen)["cflex.fms.support"]
        self.assertEqual(k.get("extra_ca"), C + "portal-ca.pem")
        self.assertEqual(k.get("client"), (C + "device.pem", C + "device.key"))
        seen.clear()
        res = verify.run(site, "app", me(site, "app", "app01"), "container", FakeRunner(),
                         as_cflex=lambda argv, mutating=True: (0, "", ""), connect=fake)
        self.assertNotIn("client", dict(seen)["cflex.fms.support"])
        self.assertIn("no device certificate", [r.detail for r in res if "portal" in r.name][0])

    def test_secret_scan_never_puts_the_value_on_a_command_line(self):
        out = []
        addf = lambda n, good, d, warn=False: out.append((n, "PASS" if good else ("WARN" if warn else "FAIL"), d))
        f = "/opt/app/cflex/secrets/db/pg.pass"
        r = FakeRunner({"sh": (0, "0 0\n", "")}, files={f: "s3cret\n"})
        verify._secret_scan(addf, r, "db")
        self.assertEqual(out[-1][1], "PASS")
        argv = r.calls[-1]
        self.assertIn(f, argv)
        self.assertFalse(any("s3cret" in a for a in argv), "the value stays in the file")
        verify._secret_scan(addf, FakeRunner({"sh": (0, "2 1\n", "")}, files={f: "x"}), "db")
        self.assertEqual(out[-1][1], "FAIL")
        self.assertIn("pg.pass: journal 2, logs 1", out[-1][2])

    def test_selinux_enforcing_and_denials_since_boot(self):
        avc = ('type=AVC msg=audit(1795231282.118:302): avc:  denied  { read } for  pid=7733 comm="node" name="portal-ca.pem" '
               'scontext=system_u:system_r:container_t:s0:c90,c254 tcontext=unconfined_u:object_r:container_file_t:s0:c541,c644 tclass=file')
        other = 'type=AVC msg=audit(1:2): avc:  denied  { read } for  pid=1 comm="edr-agent" name="x" scontext=system_u:system_r:edr_t:s0'
        def got(answers):
            out = []
            verify._selinux(lambda n, good, d, warn=False: out.append((n, "PASS" if good else ("WARN" if warn else "FAIL"), d)),
                            FakeRunner(answers))
            return out
        r = got({"getenforce": (0, "Enforcing\n", ""), "ausearch": (1, "", "<no matches>")})
        self.assertEqual([v for _, v, _ in r], ["PASS", "PASS"])
        r = got({"getenforce": (0, "Enforcing\n", ""), "ausearch": (0, avc + "\n" + other + "\n", "")})
        self.assertEqual(r[1][1], "FAIL")
        self.assertIn("node→portal-ca.pem", r[1][2])
        r = got({"getenforce": (0, "Enforcing\n", ""), "ausearch": (0, other + "\n", "")})
        self.assertEqual(r[1][1], "WARN", "another product's denial is recorded, not ours")
        self.assertEqual(got({"getenforce": (0, "Permissive\n", ""), "ausearch": (1, "", "")})[0][1], "FAIL")
        runner = FakeRunner({"getenforce": (0, "Enforcing\n", ""), "ausearch": (1, "", "")})
        verify._selinux(lambda *a, **k: None, runner)
        self.assertIn("--input-logs", runner.calls[-1], "ausearch reads stdin when it is not a terminal")


if __name__ == "__main__":
    unittest.main()
