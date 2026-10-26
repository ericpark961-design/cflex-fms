import re
import unittest

from helpers import example_site, me
from cflex_install import render

QD = "/home/cflex/.config/containers/systemd/"


def units(files):
    return {p: c for p, (c, _) in files.items() if p.startswith(QD)}


class Render(unittest.TestCase):
    def setUp(self):
        self.site = example_site()

    def all_variants(self):
        for role, hid in (("collector", "cap01"), ("app", "app01"), ("app", "app02"), ("db", "db01")):
            for pv in ("4.9.4", "5.2.2"):
                for ports in ("forward", "sysctl"):
                    yield role, hid, pv, ports, render.render(self.site, role, me(self.site, role, hid), "2.0.0",
                                                              podman_version=pv, ports_mode=ports)

    def test_no_placeholder_left_and_no_secrets(self):
        for role, hid, pv, ports, files in self.all_variants():
            for path, (content, mode) in files.items():
                self.assertNotIn("@@", content, path)
                self.assertNotRegex(content, r"(?im)^\s*(\w*PASSWORD|\w*COMMUNITY|requirepass)\s*=\s*\S", path)
                if path.endswith(".env"):
                    self.assertEqual(mode, 0o600, path)

    def test_quadlet_hardening(self):
        for role, hid, pv, ports, files in self.all_variants():
            us = units(files)
            pod = us.get(QD + "cflex-app.pod")
            for path, text in us.items():
                if path.endswith(".pod"):
                    self.assertRegex(text, r"(?m)^UserNS=keep-id:uid=1001,gid=1001$")
                    continue
                self.assertIn("Pull=never", text, path)
                self.assertIn("ReadOnly=true", text, path)
                self.assertIn("NoNewPrivileges=true", text, path)
                self.assertIn("LogDriver=journald", text, path)
                if pod and "Pod=cflex-app.pod" in text:
                    # Podman refuses --userns with --pod; the pod carries it.
                    self.assertNotRegex(text, r"(?m)^UserNS=", path)
                else:
                    self.assertRegex(text, r"(?m)^UserNS=keep-id:uid=(1001|26),gid=(1001|26)$", path)
                self.assertRegex(text, r"(?m)^HealthCmd=", path)
                self.assertNotRegex(text, r"(?im)privileged|^Network=host|AddCapability", path)
                for v in re.findall(r"(?m)^Volume=(.+)$", text):
                    self.assertRegex(v, r":(ro,)?Z$", "%s: %s" % (path, v))
                self.assertIn(":2.0.0", text)

    def test_podman4_has_no_pod_units_podman5_does(self):
        f4 = render.render(self.site, "app", me(self.site, "app", "app01"), "2.0.0", podman_version="4.9.4")
        f5 = render.render(self.site, "app", me(self.site, "app", "app01"), "2.0.0", podman_version="5.2.2")
        self.assertFalse(any(p.endswith(".pod") for p in f4))
        self.assertTrue(any(p.endswith("cflex-app.pod") for p in f5))
        web4 = f4[QD + "cflex-web.container"][0]
        self.assertIn("Network=slirp4netns:port_handler=slirp4netns", web4)
        self.assertIn("PublishPort=10.138.14.67:8443:8443/tcp", web4)
        self.assertIn("PublishPort=10.138.14.67:6379:6379/tcp", web4)
        self.assertIn("Wants=cflex-console.service cflex-redis.service", web4)
        con4 = f4[QD + "cflex-console.container"][0]
        self.assertIn("Network=container:cflex-web", con4)
        self.assertIn("BindsTo=cflex-web.service", con4)
        pod5 = f5[QD + "cflex-app.pod"][0]
        self.assertIn("Network=pasta", pod5)
        self.assertIn("Pod=cflex-app.pod", f5[QD + "cflex-web.container"][0])

    def test_ports_modes(self):
        c = me(self.site, "collector", "cap01")
        fwd = render.render(self.site, "collector", c, "2.0.0", ports_mode="forward")[QD + "cflex-collector.container"][0]
        sys_ = render.render(self.site, "collector", c, "2.0.0", ports_mode="sysctl")[QD + "cflex-collector.container"][0]
        self.assertIn("PublishPort=10.138.14.66:1162:1162/udp", fwd)
        self.assertIn("PublishPort=10.138.14.66:162:1162/udp", sys_)

    def test_standby_uses_the_primary_and_keeps_a_replica(self):
        # Q-2026-10-25-11 (A): the console on app02 uses app01's Redis; app02's own Redis replicates it.
        f = render.render(self.site, "app", me(self.site, "app", "app02"), "2.0.0", podman_version="4.9.4")
        self.assertIn(QD + "cflex-redis.container", f)
        env = f["/opt/app/cflex/config/app/app.env"][0]
        self.assertIn("REDIS_URL=redis://10.138.14.67:6379/0", env)
        self.assertIn("CONSOLE_BIND=127.0.0.1", env)
        conf = f["/opt/app/cflex/config/redis/redis.conf"][0]
        self.assertIn("\nreplicaof 10.138.14.67 6379\n", conf)
        self.assertIn("\nreplica-read-only yes\n", conf)
        self.assertNotRegex(conf, r"(?m)^\s*(masterauth|requirepass)\b", "the password stays in auth.conf")
        self.assertIn("redis-cli.sh", " ".join(f))
        pubs = re.findall(r"(?m)^PublishPort=(.+)$", "\n".join(units(f).values()))
        self.assertEqual(pubs, ["10.138.14.68:8443:8443/tcp", "10.138.14.68:6379:6379/tcp"])
        p = render.render(self.site, "app", me(self.site, "app", "app01"), "2.0.0")
        self.assertNotIn("replicaof", p["/opt/app/cflex/config/redis/redis.conf"][0].replace("# ", ""), "app01 is the primary")
        self.assertIn("REDIS_URL=redis://127.0.0.1:6379/0", p["/opt/app/cflex/config/app/app.env"][0])

    def test_nginx_peer_fallback(self):
        f = render.render(self.site, "app", me(self.site, "app", "app01"), "2.0.0")
        conf = f["/opt/app/cflex/config/nginx/cflex-console.conf"][0]
        self.assertIn("listen 8443 ssl http2;", conf)
        self.assertIn("error_page 502 504 = @peer;", conf)
        self.assertIn("proxy_pass https://10.138.14.68:443;", conf)
        self.assertIn("set_real_ip_from 10.138.14.68;", conf)
        self.assertNotIn("listen 80", conf)
        self.assertIn("if ($http_x_cflex_peer) { return 502; }", conf)

    def test_collector_env(self):
        f = render.render(self.site, "collector", me(self.site, "collector", "cap01"), "2.0.0")
        env = f["/opt/app/cflex/config/collector/collector.env"][0]
        self.assertIn("CFLEX_NODE_ID=cap01", env)
        self.assertIn("CFLEX_SITE_ID=HMA-FV", env)
        self.assertIn("CFLEX_TLS_KEY=/opt/app/cflex/certs/device.key", env)
        self.assertIn("HTTPS_PROXY=\n", env, "placeholder proxy from the example must not be written")
        self.assertIn("CFLEX_URL=https://10.138.14.67", env)
        self.assertIn("CFLEX_TRAP_PORT=1162", env)
        # WO-INT-004c: the Local Console, both app nodes active first; key and CA by path; no notify channel.
        self.assertIn("CFLEX_CONSOLE_URL=https://10.138.14.67,https://10.138.14.68\n", env)
        self.assertIn("CFLEX_CONSOLE_KEY_FILE=/opt/app/cflex/secrets/collector.key\n", env)
        self.assertIn("CFLEX_CONSOLE_CA=/opt/app/cflex/certs/console-ca.pem\n", env)
        self.assertNotIn("CFLEX_NOTIFY_CONFIG", env)
        bare = render.render(self.site, "collector", me(self.site, "collector", "cap01"), "2.0.0", profile="bare")
        self.assertIn("CFLEX_CONSOLE_KEY_FILE=/opt/app/cflex/secrets/collector/collector.key\n", bare["/opt/app/cflex/config/collector/collector.env"][0])

    def test_bare_profile(self):
        f = render.render(self.site, "collector", me(self.site, "collector", "cap01"), "2.0.0", profile="bare")
        unit = f["/etc/systemd/system/cflex-collector.service"][0]
        self.assertIn("AmbientCapabilities=CAP_NET_BIND_SERVICE", unit)
        self.assertIn("ProtectSystem=strict", unit)
        self.assertIn("CFLEX_TRAP_PORT=162", f["/opt/app/cflex/config/collector/collector.env"][0])
        a = render.render(self.site, "app", me(self.site, "app", "app01"), "2.0.0", profile="bare")
        self.assertIn("listen 443 ssl http2;", a["/etc/nginx/conf.d/cflex-console.conf"][0])

    def test_unknown_placeholder_is_an_error(self):
        with self.assertRaises(render.RenderError):
            render.fill("x @@NOPE@@", {})


if __name__ == "__main__":
    unittest.main()
