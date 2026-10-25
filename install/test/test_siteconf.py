import io
import os
import unittest

from helpers import INSTALL, example_site, siteconf


class SiteConf(unittest.TestCase):
    def test_spec_example_parses(self):
        s = example_site()
        self.assertEqual(s["tenant"], {"code": "HAEA", "timezone": "America/Los_Angeles"})
        self.assertEqual(s["hosts"]["collectors"][0]["sites"], ["HMA-FV", "KUS-IRV", "HAEA-HQ"])
        self.assertEqual([a["id"] for a in s["hosts"]["app"]], ["app01", "app02"])
        self.assertEqual(s["hosts"]["db"], {"ip": "10.138.14.69", "port": 5432})
        self.assertEqual(s["snmp"]["trap_port"], 162)
        self.assertEqual(s["portal"]["proxy"], "http://<haea-proxy>:<port>")
        self.assertEqual(s["portal"]["url"], "https://cflex.fms.support")
        self.assertIs(s["notify"]["policy"]["local_itsm"], True)
        self.assertIs(s["auth"]["saml"]["enabled"], False)
        self.assertEqual(s["install"]["user_sources"], [])
        self.assertEqual(s["install"]["privileged_ports"], "auto")
        self.assertEqual(siteconf.validate(s), [])

    def test_same_result_as_modern_pyyaml(self):
        try:
            import yaml
        except ImportError:
            self.skipTest("PyYAML not installed")
        if tuple(int(x) for x in yaml.__version__.split(".")[:2]) < (5, 1):
            self.skipTest("PyYAML %s rejects ':' in flow-mapping plain scalars (why the installer has its own loader)" % yaml.__version__)
        with io.open(os.path.join(INSTALL, "site.example.yaml"), encoding="utf-8") as f:
            src = f.read()
        self.assertEqual(siteconf.loads(src), siteconf.loads(src, use_pyyaml=True))

    def test_block_style(self):
        s = siteconf.loads("a:\n  b: 1\n  c:\n    - x\n    - y: 2\n      z: 'q # not a comment'\nd: [1, 2]  # comment\n")
        self.assertEqual(s, {"a": {"b": 1, "c": ["x", {"y": 2, "z": "q # not a comment"}]}, "d": [1, 2]})

    def test_errors_carry_line_numbers(self):
        with self.assertRaises(siteconf.ConfigError) as cm:
            siteconf.loads("a: 1\nb: { c: 2\n")
        self.assertIn("line 2", str(cm.exception))
        with self.assertRaises(siteconf.ConfigError):
            siteconf.loads("a: 1\na: 2\n")
        with self.assertRaises(siteconf.ConfigError):
            siteconf.loads("a: &anchor 1\n")

    def test_validate(self):
        s = example_site()
        s["snmp"]["trap_port"] = 1162
        s["hosts"]["app"][1]["role"] = "active"
        s["install"]["privileged_ports"] = "nat"
        errs = siteconf.validate(s)
        self.assertTrue(any("trap_port" in e for e in errs))
        self.assertTrue(any("exactly one" in e for e in errs))
        self.assertTrue(any("privileged_ports" in e for e in errs))

    def test_find_host(self):
        s = example_site()
        self.assertEqual(siteconf.find_host(s, "app", None, ["127.0.0.1", "10.138.14.68"])[1], "app02")
        self.assertEqual(siteconf.find_host(s, "db", None, ["10.138.14.69"])[2], "10.138.14.69")
        with self.assertRaises(siteconf.ConfigError):
            siteconf.find_host(s, "collector", None, ["10.1.1.1"])
        self.assertEqual(siteconf.redis_host(s)["id"], "app01")


if __name__ == "__main__":
    unittest.main()
