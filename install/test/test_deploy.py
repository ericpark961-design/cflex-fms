import json
import unittest

from helpers import FakeRunner, example_site, me
from cflex_install import deploy

QD = "/home/cflex/.config/containers/systemd/"


class FakeBundle(object):
    def __init__(self, version):
        self.version = version
        self.root = "/srv/cflex-bundle-%s" % version
        self.manifest = {"version": version, "migrations": []}

    def images_for(self, role):
        return []


def ctx(site, role, hid, runner, bundle=None, ports="forward", podman="4.9.4"):
    return deploy.Ctx(site, role, me(site, role, hid), "container", runner, bundle=bundle,
                      podman_version=podman, ports_mode=ports, log=lambda m: None)


class Firewall(unittest.TestCase):
    def setUp(self):
        self.site = example_site()

    def test_forward_mode_without_sources(self):
        r = FakeRunner(dry_run=True)
        self.assertEqual(deploy.firewall_rules(ctx(self.site, "collector", "cap01", r)),
                         [("forward-port", "port=162:proto=udp:toport=1162")])
        app01 = deploy.firewall_rules(ctx(self.site, "app", "app01", r))
        self.assertIn(("forward-port", "port=443:proto=tcp:toport=8443"), app01)
        self.assertIn(("rich-rule", 'rule family="ipv4" source address="10.138.14.68/32" port port="6379" protocol="tcp" accept'), app01)
        # Never opens the unprivileged ports themselves, never touches SSH.
        self.assertFalse(any(v in ("1162/udp", "8443/tcp") or "22" == v for _, v in app01))

    def test_sources_go_on_the_forward_rule(self):
        self.site["install"]["user_sources"] = ["10.50.0.0/16"]
        rules = deploy.firewall_rules(ctx(self.site, "app", "app02", FakeRunner(dry_run=True)))
        self.assertIn(("rich-rule", 'rule family="ipv4" source address="10.50.0.0/16" forward-port port="443" protocol="tcp" to-port="8443"'), rules)
        self.assertIn(("rich-rule", 'rule family="ipv4" source address="10.138.14.67/32" forward-port port="443" protocol="tcp" to-port="8443"'), rules)
        self.assertFalse(any(k == "forward-port" for k, _ in rules), "zone-wide forward would bypass the sources")
        # Q-2026-10-25-11 (A): app02 runs the replica, and is the primary after a promotion —
        # 6379 open to the peer only, on both nodes.
        self.assertIn(("rich-rule", 'rule family="ipv4" source address="10.138.14.67/32" port port="6379" protocol="tcp" accept'), rules)
        self.assertEqual(len([v for _, v in rules if "6379" in v]), 1)

    def test_sysctl_mode_and_db(self):
        r = FakeRunner(dry_run=True)
        self.assertEqual(deploy.firewall_rules(ctx(self.site, "collector", "cap01", r, ports="sysctl")), [("port", "162/udp")])
        self.assertIn(("service", "https"), deploy.firewall_rules(ctx(self.site, "app", "app01", r, ports="sysctl")))
        db = deploy.firewall_rules(ctx(self.site, "db", "db01", r))
        self.assertEqual(len(db), 2)
        self.assertTrue(all('port port="5432"' in v for _, v in db))


class Secrets(unittest.TestCase):
    def test_generated_secret_has_no_trailing_newline(self):
        # podman secret create passes the file byte for byte into POSTGRESQL_PASSWORD.
        r = FakeRunner(answers={"podman secret inspect": (0, "", "")}, dry_run=False)
        c = ctx(example_site(), "db", "db01", r)
        deploy._secrets(c)
        pw = r.files[deploy.BASE + "/secrets/db/pg.pass"]
        self.assertEqual(len(pw), 64)
        self.assertNotIn("\n", pw)

    def test_standby_refuses_to_invent_shared_secrets(self):
        r = FakeRunner(dry_run=False)
        with self.assertRaises(deploy.DeployError) as cm:
            deploy._secrets(ctx(example_site(), "app", "app02", r))
        self.assertIn("copy it from app01", str(cm.exception))


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.site = example_site()
        self.saved = deploy.wait_healthy

    def tearDown(self):
        deploy.wait_healthy = self.saved

    def runner(self, state):
        r = FakeRunner(answers={"systemctl --user": (0, "", ""), "podman image exists": (0, "", "")}, dry_run=True)
        if state:
            r.files[deploy.STATE] = json.dumps(state)
        return r

    def test_active_node_refuses_upgrade_before_standby(self):
        r = self.runner({"version": "1.0.0", "profile": "container"})
        with self.assertRaises(deploy.DeployError) as cm:
            deploy.upgrade(ctx(self.site, "app", "app01", r, FakeBundle("1.1.0")))
        self.assertIn("standby first", str(cm.exception))

    def test_failed_upgrade_rolls_back(self):
        r = self.runner({"version": "1.0.0", "profile": "container"})
        seq = [(False, "unhealthy: cflex-collector"), (True, "healthy: cflex-collector")]
        deploy.wait_healthy = lambda c: seq.pop(0)
        with self.assertRaises(deploy.DeployError) as cm:
            deploy.upgrade(ctx(self.site, "collector", "cap01", r, FakeBundle("1.1.0")))
        self.assertIn("rolled back to 1.0.0", str(cm.exception))
        st = json.loads(r.files[deploy.STATE])
        self.assertEqual(st["version"], "1.0.0")
        self.assertEqual(st["failed_upgrade"], "1.1.0")
        unit = r.files[QD + "cflex-collector.container"]
        self.assertIn("Image=localhost/cflex/collector:1.0.0", unit)

    def test_upgrade_then_rollback(self):
        r = self.runner({"version": "1.0.0", "profile": "container"})
        deploy.wait_healthy = lambda c: (True, "healthy")
        deploy.upgrade(ctx(self.site, "app", "app02", r, FakeBundle("1.1.0")))
        st = json.loads(r.files[deploy.STATE])
        self.assertEqual((st["version"], st["previous"]), ("1.1.0", "1.0.0"))
        self.assertIn("Image=localhost/cflex/app:1.1.0", r.files[QD + "cflex-console.container"])
        deploy.rollback(ctx(self.site, "app", "app02", r))
        st = json.loads(r.files[deploy.STATE])
        self.assertEqual((st["version"], st["previous"]), ("1.0.0", "1.1.0"))
        self.assertIn("Image=localhost/cflex/app:1.0.0", r.files[QD + "cflex-console.container"])

    def test_install_retires_the_promotion_record_once_site_yaml_agrees(self):
        r = self.runner({"version": "1.0.0", "profile": "container", "redis_primary": "app02", "redis_promoted_at": "t"})
        self.site["install"]["redis_host"] = "app02"
        deploy.wait_healthy = lambda c: (True, "healthy")
        saved_apply = deploy.apply
        deploy.apply = lambda c, steps: None   # the steps are tested elsewhere; this is about the state file
        try:
            deploy.install(ctx(self.site, "app", "app02", r, FakeBundle("1.1.0")))
        finally:
            deploy.apply = saved_apply
        st = json.loads(r.files[deploy.STATE])
        self.assertEqual(st["version"], "1.1.0")
        self.assertNotIn("redis_primary", st, "site.yaml caught up, so the record is retired")

    def test_install_plan_lists_every_step_and_changes_nothing_without_yes(self):
        r = self.runner(None)
        c = ctx(self.site, "collector", "cap01", r, FakeBundle("1.0.0"))
        text = deploy.describe(c, deploy.plan_install(c))
        for word in ("subuid", "linger", "podman load", "Quadlet", "firewalld", "restart"):
            self.assertIn(word, text)
        self.assertEqual(r.writes, {})


class Promote(unittest.TestCase):
    """Q-2026-10-25-11 (A): app01's VM is gone; `cflex-install promote --role app` on app02."""

    def setUp(self):
        self.site = example_site()
        self.role = {"now": "slave"}

        def info(argv):
            return (0, "# Replication\r\nrole:%s\r\nmaster_link_status:down\r\nmaster_last_io_seconds_ago:42\r\n" % self.role["now"], "")

        def replicaof(argv):
            self.role["now"] = "master"
            return (0, "OK", "")
        self.r = FakeRunner(answers={"INFO replication": info, "REPLICAOF NO ONE": replicaof,
                                     "systemctl --user restart cflex-console.service": (0, "", "")})
        self.r.files[deploy.STATE] = json.dumps({"version": "1.0.0", "profile": "container"})

    def calls(self, word):
        return [c for c in self.r.calls if word in " ".join(c)]

    def test_refused_while_the_old_primary_still_answers(self):
        with self.assertRaises(deploy.DeployError) as cm:
            deploy.promote(ctx(self.site, "app", "app02", self.r), probe=lambda h, p: (True, "%s:%s connected" % (h, p)))
        self.assertIn("two primaries", str(cm.exception))
        self.assertEqual(self.calls("REPLICAOF"), [], "nothing changed")

    def test_promotes_the_replica_points_the_console_at_it_and_records_it(self):
        probed = []
        msg = deploy.promote(ctx(self.site, "app", "app02", self.r), probe=lambda h, p: (probed.append((h, p)) or (False, "refused")))
        self.assertEqual(probed, [("10.138.14.67", 6379)], "asked whether app01 is really gone")
        self.assertEqual(len(self.calls("REPLICAOF NO ONE")), 1)
        self.assertEqual(len(self.calls("restart cflex-console.service")), 1)
        conf = self.r.files["/opt/app/cflex/config/redis/redis.conf"]
        self.assertNotRegex(conf, r"(?m)^replicaof", "a restart keeps it the primary")
        self.assertIn("REDIS_URL=redis://127.0.0.1:6379/0", self.r.files["/opt/app/cflex/config/app/app.env"])
        st = json.loads(self.r.files[deploy.STATE])
        self.assertEqual((st["redis_primary"], st["redis_previous_primary"], st["version"]), ("app02", "app01", "1.0.0"))
        self.assertIn("install.redis_host: app02", msg)
        # Again: nothing to do.
        self.assertIn("nothing to do", deploy.promote(ctx(self.site, "app", "app02", self.r), probe=lambda h, p: (False, "")))

    def test_install_will_not_undo_a_promotion_until_site_yaml_agrees(self):
        deploy.promote(ctx(self.site, "app", "app02", self.r), probe=lambda h, p: (False, ""))
        for op in (lambda c: deploy.upgrade(c, standby_done=True), deploy.rollback):
            with self.assertRaises(deploy.DeployError) as cm:
                op(ctx(self.site, "app", "app02", self.r, FakeBundle("1.1.0")))
            self.assertIn("set install.redis_host: app02", str(cm.exception))
        self.site["install"]["redis_host"] = "app02"
        deploy.check_promotion(ctx(self.site, "app", "app02", self.r))
        self.assertNotIn("redis_primary", json.loads(self.r.files[deploy.STATE]))
        # app01, repaired, renders as the replica of app02.
        f = deploy.render.render(self.site, "app", me(self.site, "app", "app01"), "1.0.0")
        self.assertIn("\nreplicaof 10.138.14.68 6379\n", f["/opt/app/cflex/config/redis/redis.conf"][0])
        self.assertIn("REDIS_URL=redis://10.138.14.68:6379/0", f["/opt/app/cflex/config/app/app.env"][0])

    def test_nothing_to_do_on_the_primary_and_not_for_other_roles(self):
        self.assertIn("already the Redis primary", deploy.promote(ctx(self.site, "app", "app01", self.r)))
        with self.assertRaises(deploy.DeployError):
            deploy.promote(ctx(self.site, "collector", "cap01", self.r))
        self.assertEqual(self.calls("REPLICAOF"), [])

    def test_auth_conf_carries_masterauth_on_both_nodes(self):
        for hid in ("app01", "app02"):
            r = FakeRunner()
            r.files[deploy.BASE + "/secrets/app/redis.pass"] = "pw"
            r.files[deploy.BASE + "/secrets/app/console.key"] = "k"
            deploy._secrets(ctx(self.site, "app", hid, r))
            self.assertEqual(r.files[deploy.BASE + "/secrets/redis/auth.conf"], "requirepass pw\nmasterauth pw\n", hid)


if __name__ == "__main__":
    unittest.main()
