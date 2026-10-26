import io
import json
import os
import unittest

from helpers import REPO, FakeRunner, example_site, me
from cflex_install import netcheck

SS_LISTEN_COLLECTOR = """\
udp   UNCONN 0      0            127.0.0.1:323        0.0.0.0:*    users:(("chronyd",pid=812,fd=5))
udp   UNCONN 0      0         10.138.14.66:1162       0.0.0.0:*    users:(("slirp4netns",pid=2201,fd=12))
tcp   LISTEN 0      128            0.0.0.0:22         0.0.0.0:*    users:(("sshd",pid=1001,fd=3))
tcp   LISTEN 0      128               [::]:22            [::]:*    users:(("sshd",pid=1001,fd=4))
tcp   LISTEN 0      128            0.0.0.0:9090       0.0.0.0:*    users:(("systemd",pid=1,fd=40))
"""
SS_EST_COLLECTOR = """\
0      0      10.138.14.66:51514   40.114.79.164:443   users:(("slirp4netns",pid=2201,fd=20))
0      0      10.138.14.66:40022   10.138.14.67:443    users:(("slirp4netns",pid=2201,fd=21))
0      0      10.138.14.66:22      10.9.9.9:50000      users:(("sshd",pid=3001,fd=4))
0      0      10.138.14.66:41000   104.16.1.1:443      users:(("slirp4netns",pid=2201,fd=22))
"""
FILES = {"/opt/app/cflex/config/nmc-targets.txt": "# x\n10.112.0.76\n10.112.0.77\n",
         "/etc/resolv.conf": "nameserver 10.1.1.53\n"}


def spec_rows():
    with io.open(os.path.join(REPO, "docs/spec/01_SPEC_INTERNAL_Probe-OnPrem_for-ClaudeCode_v1.md"), encoding="utf-8") as f:
        text = f.read()
    table = []
    for line in text.split("### 네트워크", 1)[1].splitlines()[1:]:
        if line.startswith("|"):
            table.append(line)
        elif table:
            break
    rows = []
    for line in table[2:]:  # header, separator
        rows.append([c.strip().replace("**", "") for c in line.strip().strip("|").split("|")])
    return rows


class NetCheck(unittest.TestCase):
    def setUp(self):
        self.site = example_site()
        self.matrix = netcheck.load_matrix()

    def test_matrix_is_spec_table_verbatim(self):
        rows = spec_rows()
        self.assertEqual(len(rows), len(self.matrix["rows"]))
        for (d, p, u), r in zip(rows, self.matrix["rows"]):
            self.assertEqual((r["direction"], r["port"], r["purpose"]), (d, p, u))

    def test_parse_ss(self):
        l = netcheck.parse_ss(SS_LISTEN_COLLECTOR)
        self.assertEqual(len(l), 5)
        self.assertEqual(l[1], {"proto": "udp", "local": "10.138.14.66", "lport": 1162, "peer": "0.0.0.0", "pport": None, "procs": ["slirp4netns"]})
        self.assertEqual(l[3]["local"], "::")
        e = netcheck.parse_ss(SS_EST_COLLECTOR, default_proto="tcp")
        self.assertEqual(e[0]["peer"], "40.114.79.164")
        self.assertEqual(e[0]["pport"], 443)

    def evaluate(self, forward_rules=frozenset([("udp", 162, 1162)])):
        r = FakeRunner(files=FILES)
        return netcheck.evaluate(self.matrix, self.site, "collector", me(self.site, "collector", "cap01"),
                                 netcheck.parse_ss(SS_LISTEN_COLLECTOR), netcheck.parse_ss(SS_EST_COLLECTOR, "tcp"),
                                 r, forward_mode=True, forward_rules=forward_rules)

    def test_collector_report(self):
        rep = self.evaluate()
        by = {r["id"]: r for r in rep["rows"]}
        self.assertEqual(by["FW-2"]["verdict"], "PASS")
        self.assertIn("162→1162", by["FW-2"]["checks"][0]["observed"])
        # D-13 (WO-INT-012): the Portal row is the app's; on a collector it is N/A, said why —
        # and a collector connection to the Portal is then a C-Flex flow outside v3 (an extra, FAIL).
        self.assertEqual(by["FW-4"]["verdict"], "N/A")
        self.assertIn("해당 없음 (D-13)", by["FW-4"]["checks"][0]["observed"])
        self.assertEqual(by["FW-4"]["direction"], "collector/app → cflex.fms.support (40.114.79.164)", "v3 text kept verbatim")
        self.assertEqual(by["FW-5"]["verdict"], "N/A")
        fw7 = by["FW-7"]["checks"]
        self.assertEqual(fw7[0]["verdict"], "PASS")  # collector → app 443, live
        self.assertTrue(all(c["verdict"] == "N/A" for c in fw7[1:]))
        # Q-2026-10-25-10 (A): cap01 → SMTP relay / proxy (Teams, ServiceNow) is not the collector's;
        # the report says so in each line, not only as a bare N/A.
        fw8 = {c["check"]: c for c in by["FW-8"]["checks"]}
        for k in ("app → SMTP 릴레이", "app → 프록시 → Teams 443", "app → ServiceNow 443"):
            self.assertEqual(fw8[k]["verdict"], "N/A", k)
            self.assertIn("해당 없음", fw8[k]["observed"])
            self.assertIn("Local Console(app)이 발송", fw8[k]["observed"])
        # sshd on IPv4 and IPv6 both belong to FW-6 — no extra line for the second socket.
        extras = {(e["addr"], e["verdict"]) for e in rep["extras"]}
        self.assertIn(("0.0.0.0:9090", "WARN"), extras)            # cockpit: not ours, recorded
        self.assertIn(("104.16.1.1:443", "FAIL"), extras)          # ours, not in v3
        self.assertIn(("40.114.79.164:443", "FAIL"), extras)       # a collector reaching the Portal (D-13: it must not)
        self.assertFalse(any(e["addr"].endswith(":22") for e in rep["extras"]))
        self.assertFalse(rep["ok"])

    def test_app_portal_row_fw4(self):
        # D-13: app01/app02 → Portal 443 is the required FW-4 path.
        est = netcheck.parse_ss("0      0      10.138.14.67:51514   40.114.79.164:443   users:((\"conmon\",pid=2201,fd=20))\n", "tcp")
        rep = netcheck.evaluate(self.matrix, self.site, "app", me(self.site, "app", "app01"), [], est, FakeRunner(files=FILES))
        fw4 = [r for r in rep["rows"] if r["id"] == "FW-4"][0]
        self.assertEqual(fw4["verdict"], "PASS", fw4)
        self.assertIn("연결 1건", fw4["checks"][0]["observed"])
        none = netcheck.evaluate(self.matrix, self.site, "app", me(self.site, "app", "app01"), [], [], FakeRunner(files=FILES))
        self.assertNotEqual([r for r in none["rows"] if r["id"] == "FW-4"][0]["verdict"], "N/A", "required on app, not skipped")

    def test_forward_rule_missing_fails_fw2(self):
        rep = self.evaluate(forward_rules=frozenset())
        fw2 = [r for r in rep["rows"] if r["id"] == "FW-2"][0]
        self.assertEqual(fw2["verdict"], "FAIL")

    def test_rich_rule_forward_ports(self):
        rr = 'rule family="ipv4" source address="10.0.0.0/8" forward-port port="443" protocol="tcp" to-port="8443"'
        self.assertEqual(netcheck.parse_forward_rules("port=162:proto=udp:toport=1162", rr),
                         {("udp", 162, 1162), ("tcp", 443, 8443)})

    def test_text_output_has_spec_columns(self):
        out = netcheck.format_text(self.evaluate())
        self.assertIn("| ID | 방향 | 포트 | 용도 | 판정 |", out)
        self.assertIn("| FW-2 | NMC → collector | UDP 162 | trap | PASS |", out)
        self.assertRegex(out, r"결과: FAIL — PASS \d+ · FAIL \d+")
        json.dumps(self.evaluate(), ensure_ascii=False)


if __name__ == "__main__":
    unittest.main()
