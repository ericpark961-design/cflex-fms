"""Render the templates in install/templates for one host.

render(site, role, me, ...) → {absolute host path: (content, mode)}. Pure — no
host access — so tests can render every role × profile × Podman generation and
check the result (test/test_render.py).

Placeholders are @@NAME@@ (not $NAME: nginx and shell use '$'). A placeholder
left unrendered is an error, not an empty string.
"""

import io
import os
import re

from . import __version__, siteconf

TEMPLATES = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "templates"))

BASE = "/opt/app/cflex"
CONFIG = BASE + "/config"
SECRETS = BASE + "/secrets"
QUADLET_DIR_REL = ".config/containers/systemd"

# In-container paths (the Quadlet units mount the host dirs here).
C_CONFIG = "/opt/app/cflex/config"
C_SECRETS = "/opt/app/cflex/secrets"
C_QUEUE = "/opt/app/cflex/queue"
C_DATA = "/opt/app/cflex/data"

UNPRIV = {"trap": 1162, "https": 8443}


class RenderError(Exception):
    pass


def fill(text, values, name="template"):
    def rep(m):
        k = m.group(1)
        if k not in values:
            raise RenderError("%s: no value for @@%s@@" % (name, k))
        return str(values[k])
    out = re.sub(r"@@([A-Z0-9_]+)@@", rep, text)
    return out


def template(rel):
    with io.open(os.path.join(TEMPLATES, rel), encoding="utf-8") as f:
        return f.read()


def podman_major(version):
    m = re.match(r"(\d+)", str(version or ""))
    return int(m.group(1)) if m else 0


def network_mode(podman_version):
    # Both keep the client's source address on published ports: the trap source
    # identifies the NMC, and the console's audit log records the user's IP.
    # rootlesskit (the 4.x default port handler) would show every packet as from 10.0.2.2.
    return "pasta" if podman_major(podman_version) >= 5 else "slirp4netns:port_handler=slirp4netns"


def host_ports(ports_mode):
    """Host-side ports for trap and console: forward → unprivileged + firewalld forward-port; sysctl → real ports."""
    if ports_mode == "forward":
        return {"trap": UNPRIV["trap"], "https": UNPRIV["https"]}
    if ports_mode == "sysctl":
        return {"trap": 162, "https": 443}
    raise RenderError("ports mode must be forward or sysctl, got %r" % ports_mode)


def _no_proxy(site):
    ips = [ip for _, _, ip, _ in siteconf.hosts(site) if ip]
    return ",".join(["localhost", "127.0.0.1"] + ips)


def _proxy(site):
    p = siteconf.get(site, "portal.proxy") or ""
    return "" if "<" in p else p


def common_values(site, role, me, version, profile):
    apps = siteconf.get(site, "hosts.app") or []
    active = next((a for a in apps if a.get("role") == "active"), apps[0] if apps else {})
    portal_cert = siteconf.get(site, "portal.mtls_cert") or (BASE + "/certs/device.pem")
    return {
        "INSTALLER_VERSION": __version__,
        "VERSION": version,
        "NODE_ID": me[1],
        "HOST_IP": me[2],
        "TENANT": siteconf.get(site, "tenant.code"),
        "TIMEZONE": siteconf.get(site, "tenant.timezone") or "UTC",
        "PROFILE": profile,
        "PROXY": _proxy(site),
        "NO_PROXY": _no_proxy(site),
        "ACTIVE_APP_IP": active.get("ip", ""),
        "PORTAL_ENABLED": "1" if siteconf.get(site, "portal.enabled", True) else "0",
        "PORTAL_URL": siteconf.get(site, "portal.url") or "",
        "MTLS_CERT": portal_cert,
        "MTLS_KEY": re.sub(r"\.pem$", ".key", portal_cert) if portal_cert.endswith(".pem") else portal_cert + ".key",
        "PORTAL_CA": os.path.join(os.path.dirname(portal_cert), "portal-ca.pem"),
    }


def console_urls(site):
    """The Local Console as the collector reaches it: every app node's nginx on 443, active first."""
    apps = sorted(siteconf.get(site, "hosts.app") or [], key=lambda a: a.get("role") != "active")
    return ",".join("https://%s" % (a.get("hostname") or a.get("ip")) for a in apps if a.get("hostname") or a.get("ip"))


def _collector_env(site, me, v, profile):
    x = me[3] or {}
    sites = x.get("sites") or []
    vals = dict(v)
    vals.update({
        "CONSOLE_URLS": console_urls(site),
        "COLLECTOR_SECRETS": C_SECRETS if profile == "container" else SECRETS + "/collector",
        "SITE_ID": sites[0] if sites else siteconf.get(site, "tenant.code"),
        "POLL_MS": int(siteconf.get(site, "snmp.poll_interval_sec", 60)) * 1000,
        "BUFFER_DAYS": siteconf.get(site, "portal.buffer_days", 7),
        "QUEUE_DIR": C_QUEUE if profile == "container" else BASE + "/queue",
        "HEALTH_FILE": "/tmp/cflex-collector-health.json",
        "SNMP_VERSION": "3" if str(siteconf.get(site, "snmp.default_version", 3)) == "3" else "2c",
        "TRAP_LISTEN_PORT": UNPRIV["trap"] if profile == "container" else 162,
    })
    return fill(template("env/collector.env"), vals, "collector.env")


def _app_env(site, me, v, profile):
    rh = siteconf.redis_host(site) or {}
    local_redis = rh.get("id") == me[1]
    vals = dict(v)
    vals.update({
        "CONSOLE_BIND": "127.0.0.1",
        "DATA_DIR": C_DATA if profile == "container" else BASE + "/data",
        "SECRETS_DIR": C_SECRETS if profile == "container" else SECRETS + "/app",
        "REDIS_ADDR": "127.0.0.1" if local_redis else rh.get("ip"),
    })
    return fill(template("env/app.env"), vals, "app.env")


def _nginx(site, me, v, listen_port):
    apps = siteconf.get(site, "hosts.app") or []
    peers = [a for a in apps if a.get("id") != me[1]]
    vals = dict(v)
    vals["LISTEN_PORT"] = listen_port
    if peers:
        p = peers[0]
        vals.update({
            "PEER_ID": p.get("id"), "PEER_IP": p.get("ip"),
            # The peer forwards the user's address in X-Forwarded-For; believe it only from the peer.
            "REALIP": "    set_real_ip_from %s;\n    real_ip_header X-Forwarded-For;" % p.get("ip"),
            "PEER_FALLBACK": "        # Local app down → the peer node, over 443.\n        error_page 502 504 = @peer;",
            "PEER_LOCATION": "\n".join([
                "    location @peer {",
                "        # One hop only: a request the peer already forwarded is not sent back.",
                "        if ($http_x_cflex_peer) { return 502; }",
                "        proxy_pass https://%s:443;" % p.get("ip"),
                "        proxy_http_version 1.1;",
                "        proxy_set_header Connection \"\";",
                "        proxy_set_header Host $host;",
                "        proxy_set_header X-Forwarded-For $remote_addr;",
                "        proxy_set_header X-Forwarded-Proto https;",
                "        proxy_set_header X-CFlex-Peer 1;",
                "        proxy_ssl_verify on;",
                "        proxy_ssl_trusted_certificate /opt/app/cflex/certs/console-ca.pem;",
                "        proxy_ssl_name %s;" % (p.get("hostname") or p.get("ip")),
                "    }",
            ]),
        })
    else:
        vals.update({"PEER_ID": "-", "PEER_IP": "-", "REALIP": "", "PEER_FALLBACK": "", "PEER_LOCATION": ""})
    return fill(template("nginx/cflex-console.conf"), vals, "cflex-console.conf")


def render(site, role, me, version, profile="container", podman_version="4.9", ports_mode="forward", home="/home/cflex"):
    if role not in siteconf.ROLES:
        raise RenderError("role must be one of %s" % ", ".join(siteconf.ROLES))
    if profile not in ("container", "bare"):
        raise RenderError("profile must be container or bare")
    v = common_values(site, role, me, version, profile)
    files = {}
    if profile == "container":
        net = network_mode(podman_version)
        hp = host_ports(ports_mode)
        v.update({"NETWORK": net, "TRAP_HOST_PORT": hp["trap"], "HTTPS_HOST_PORT": hp["https"]})
        qd = os.path.join(home, QUADLET_DIR_REL)
        if role == "collector":
            files[os.path.join(qd, "cflex-collector.container")] = (fill(template("quadlet/cflex-collector.container"), v, "collector"), 0o644)
            files[CONFIG + "/collector/collector.env"] = (_collector_env(site, me, v, profile), 0o600)
        elif role == "app":
            files.update(_render_app_container(site, me, v, podman_version, qd))
        else:
            db = siteconf.get(site, "hosts.db") or {}
            v["DB_PORT"] = db.get("port", 5432)
            files[os.path.join(qd, "cflex-postgres.container")] = (fill(template("quadlet/cflex-postgres.container"), v, "postgres"), 0o644)
    else:
        if role == "collector":
            files["/etc/systemd/system/cflex-collector.service"] = (fill(template("systemd/cflex-collector.service"), v, "collector.service"), 0o644)
            files[CONFIG + "/collector/collector.env"] = (_collector_env(site, me, v, profile), 0o600)
        elif role == "app":
            files["/etc/systemd/system/cflex-app.service"] = (fill(template("systemd/cflex-app.service"), v, "app.service"), 0o644)
            files[CONFIG + "/app/app.env"] = (_app_env(site, me, v, profile), 0o600)
            files["/etc/nginx/conf.d/cflex-console.conf"] = (_nginx(site, me, v, 443), 0o644)
        # bare db: PostgreSQL 16 from AppStream, configured by WO-INT-008.
    return files


def _in_pod(unit):
    # Podman refuses --userns together with --pod: inside a pod the user namespace is the pod's,
    # so cflex-app.pod carries UserNS=keep-id and the member units must not.
    return re.sub(r"(?m)^UserNS=.*\n", "", unit)


def redis_replication(site, me):
    """redis.conf lines for this app node (DECISIONS Q-2026-10-25-11 (A)).

    Every app node runs Redis. install.redis_host is the primary — the consoles on
    both nodes use it — and the other node keeps a replica (6379 between the app
    nodes, v3 FW-7), so its sessions survive the primary's VM. Promotion is manual
    (`cflex-install promote --role app`): no automatic failover, no split brain.
    """
    rh = siteconf.redis_host(site) or {}
    if rh.get("id") == me[1]:
        return "# Primary (install.redis_host = %s). The other app node replicates from here." % me[1]
    return "\n".join([
        "# Replica of the primary %s (install.redis_host). Read-only until promoted:" % rh.get("id"),
        "#   cflex-install promote --role app   (docs/install/REDIS_FAILOVER.md)",
        "replicaof %s 6379" % rh.get("ip"),
        "replica-read-only yes",
        "# Keep serving the last copy while the link is down; the console only reads it after promotion.",
        "replica-serve-stale-data yes",
    ])


def _render_app_container(site, me, v, podman_version, qd):
    files = {}
    pod = podman_major(podman_version) >= 5
    # Redis on both app nodes: the primary, and a replica on the other (Q-2026-10-25-11 (A)).
    redis_pub = "PublishPort=%s:6379:6379/tcp" % me[2]
    sidecars = ["cflex-console", "cflex-redis"]
    vv = dict(v)
    if pod:
        vv.update({
            "REDIS_PUBLISH": redis_pub,
            "WEB_NETWORK": "Pod=cflex-app.pod",
            "WEB_UNIT_DEPS": "",
            "SIDECAR_NETWORK": "Pod=cflex-app.pod",
            "SIDECAR_UNIT_DEPS": "",
        })
        files[os.path.join(qd, "cflex-app.pod")] = (fill(template("quadlet/cflex-app.pod"), vv, "app.pod"), 0o644)
    else:
        # Podman 4.x: no .pod units. cflex-web owns the network namespace and its ports;
        # the others join it. BindsTo stops them with it; Wants starts them again with it.
        pubs = ["PublishPort=%s:%s:8443/tcp" % (me[2], v["HTTPS_HOST_PORT"]), redis_pub]
        vv.update({
            "WEB_NETWORK": "Network=%s\n%s" % (v["NETWORK"], "\n".join(pubs)),
            "WEB_UNIT_DEPS": "Wants=%s" % " ".join(s + ".service" for s in sidecars),
            "SIDECAR_NETWORK": "Network=container:cflex-web",
            "SIDECAR_UNIT_DEPS": "BindsTo=cflex-web.service\nAfter=cflex-web.service",
        })
    member = _in_pod if pod else (lambda u: u)
    files[os.path.join(qd, "cflex-web.container")] = (member(fill(template("quadlet/cflex-web.container"), vv, "web")), 0o644)
    files[os.path.join(qd, "cflex-console.container")] = (member(fill(template("quadlet/cflex-console.container"), vv, "console")), 0o644)
    files[os.path.join(qd, "cflex-redis.container")] = (member(fill(template("quadlet/cflex-redis.container"), vv, "redis")), 0o644)
    rv = dict(v)
    rv["REDIS_REPLICATION"] = redis_replication(site, me)
    files[CONFIG + "/redis/redis.conf"] = (fill(template("redis/redis.conf"), rv, "redis.conf"), 0o644)
    files[CONFIG + "/redis/healthcheck.sh"] = (template("redis/healthcheck.sh"), 0o755)
    files[CONFIG + "/redis/redis-cli.sh"] = (template("redis/redis-cli.sh"), 0o755)
    files[CONFIG + "/app/app.env"] = (_app_env(site, me, v, "container"), 0o600)
    files[CONFIG + "/nginx/cflex-console.conf"] = (_nginx(site, me, v, UNPRIV["https"]), 0o644)
    return files
