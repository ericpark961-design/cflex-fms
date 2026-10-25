import unittest

from helpers import OS_RELEASE_RHEL810, FakeRunner, example_site
from cflex_install import preflight


def host(extra=None, ips="10.138.14.67", podman="podman version 4.9.4-rhel"):
    answers = {
        "ip -o -4 addr show": (0, "2: eth0    inet %s/24 brd x scope global eth0\n" % ips, ""),
        "hostname -s": (0, "haeipfmsapp01v\n", ""),
        "getenforce": (0, "Enforcing\n", ""),
        "systemctl is-active firewalld": (0, "active\n", ""),
        "timedatectl show -p NTPSynchronized --value": (0, "yes\n", ""),
        "df -P -k": (0, "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 209715200 1000 200000000 1% /opt/app\n", ""),
        "id -u cflex": (0, "1001\n", ""),
        "podman --version": (0, podman + "\n", ""),
        "rpm -q": (0, "pkg-1.0\n", ""),
        "loginctl show-user cflex -p Linger --value": (0, "yes\n", ""),
        "ss -H -n -l -t -u -p": (0, "", ""),
    }
    answers.update(extra or {})
    return FakeRunner(answers=answers, files={"/etc/os-release": OS_RELEASE_RHEL810, "/etc/subuid": "cflex:100000:65536\n"},
                      mounts={"/opt/app"})


class Preflight(unittest.TestCase):
    def setUp(self):
        self.site = example_site()

    def verdicts(self, checks):
        return {c.name: c.verdict for c in checks}

    def test_ready_host_passes_and_makes_no_network_call(self):
        r = host()
        checks, me, facts = preflight.run(self.site, "app", "container", r)
        bad = [(c.name, c.detail) for c in checks if c.verdict == "FAIL"]
        self.assertEqual(bad, [])
        self.assertEqual(me[1], "app01")
        self.assertEqual(facts["ports_mode"], "forward")
        for argv in r.calls:
            self.assertIn(argv[0], preflight.READ_ONLY_COMMANDS, argv)
            self.assertNotIn("pull", argv)
            self.assertNotIn("dnf", argv)

    def test_podman_too_old_and_selinux_disabled(self):
        r = host({"getenforce": (0, "Disabled\n", "")}, podman="podman version 4.4.1")
        v = self.verdicts(preflight.run(self.site, "app", "container", r)[0])
        self.assertEqual(v["podman"], "FAIL")
        self.assertEqual(v["selinux"], "FAIL")

    def test_podman5_needs_passt_not_slirp4netns(self):
        r = host(podman="podman version 5.2.2")
        names = [c.name for c in preflight.run(self.site, "app", "container", r)[0]]
        self.assertIn("rpm passt", names)
        self.assertNotIn("rpm slirp4netns", names)

    def test_wrong_host(self):
        r = host(ips="10.1.2.3")
        checks, me, _ = preflight.run(self.site, "app", "container", r)
        self.assertIsNone(me)
        self.assertEqual(self.verdicts(checks)["host identity"], "FAIL")

    def test_sysctl_fallback_without_firewalld(self):
        r = host({"systemctl is-active firewalld": (3, "inactive\n", "")})
        checks, _, facts = preflight.run(self.site, "app", "container", r)
        self.assertEqual(facts["ports_mode"], "sysctl")
        self.assertEqual(self.verdicts(checks)["firewalld"], "WARN")

    def test_port_taken_by_someone_else(self):
        busy = 'tcp LISTEN 0 128 0.0.0.0:8443 0.0.0.0:* users:(("java",pid=9,fd=3))\n'
        r = host({"ss -H -n -l -t -u -p": (0, busy, "")})
        v = self.verdicts(preflight.run(self.site, "app", "container", r)[0])
        self.assertEqual(v["ports free"], "FAIL")

    def test_bare_needs_node20(self):
        r = host({"rpm -q nodejs": (0, "nodejs-16.20.2-1.module+el8\n", "")})
        checks, _, _ = preflight.run(self.site, "collector", "bare", r, host_id="cap01")
        self.assertEqual(self.verdicts(checks)["rpm nodejs"], "FAIL")


if __name__ == "__main__":
    unittest.main()
