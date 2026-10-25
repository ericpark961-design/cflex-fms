"""verify — services up, and every path in spec 01 §1 that this host uses actually connects (§3.3).

Connectivity is TCP (+ TLS handshake where the far end is HTTPS), through the
HAEA proxy when site.yaml has one. Nothing is sent except with --send-test,
which runs the existing test-ticket command (WO-INT-003) inside the collector.
Proxy credentials come from the URL and are never printed.
"""

import base64
import socket
import ssl

from . import netcheck, siteconf
from .sysrun import ok

TIMEOUT = 8


class Result(object):
    def __init__(self, name, verdict, detail):
        self.name, self.verdict, self.detail = name, verdict, detail


def _parse_proxy(url):
    if not url or "<" in url:
        return None
    rest = url.split("://", 1)[-1].rstrip("/")
    auth = None
    if "@" in rest:
        auth, rest = rest.rsplit("@", 1)
    host, _, port = rest.partition(":")
    return {"host": host, "port": int(port or 8080), "auth": auth}


def redact(url):
    p = _parse_proxy(url)
    return "%s:%s%s" % (p["host"], p["port"], " (auth)" if p["auth"] else "") if p else "-"


def tcp(host, port, timeout=TIMEOUT, banner=False):
    try:
        s = socket.create_connection((host, int(port)), timeout=timeout)
    except (socket.error, socket.timeout) as e:
        return False, "%s:%s %s" % (host, port, e)
    try:
        if banner:
            s.settimeout(timeout)
            line = s.recv(256).decode("latin-1").strip().splitlines()
            return bool(line and line[0].startswith("220")), "%s:%s banner %s" % (host, port, (line[0][:60] if line else "none"))
        return True, "%s:%s connected" % (host, port)
    except (socket.error, socket.timeout) as e:
        return False, "%s:%s %s" % (host, port, e)
    finally:
        s.close()


def tls(host, port=443, proxy=None, cafile=None, verify=True, timeout=TIMEOUT):
    """TCP (or proxy CONNECT) + TLS handshake to host:port. → (ok, detail)."""
    try:
        if proxy:
            s = socket.create_connection((proxy["host"], proxy["port"]), timeout=timeout)
            req = "CONNECT %s:%d HTTP/1.1\r\nHost: %s:%d\r\n" % (host, port, host, port)
            if proxy.get("auth"):
                req += "Proxy-Authorization: Basic %s\r\n" % base64.b64encode(proxy["auth"].encode()).decode()
            s.sendall((req + "\r\n").encode())
            buf = b""
            while b"\r\n\r\n" not in buf and len(buf) < 8192:
                chunk = s.recv(1024)
                if not chunk:
                    break
                buf += chunk
            status = buf.split(b"\r\n", 1)[0].decode("latin-1")
            if " 200" not in status:
                s.close()
                return False, "proxy %s:%s refused CONNECT %s:%d: %s" % (proxy["host"], proxy["port"], host, port, status or "no answer")
        else:
            s = socket.create_connection((host, port), timeout=timeout)
        ctx = ssl.create_default_context(cafile=cafile) if verify else ssl._create_unverified_context()
        if not verify:
            ctx.check_hostname = False
        t = ctx.wrap_socket(s, server_hostname=host)
        ver = t.version()
        t.close()
        return True, "%s:%d TLS ok (%s%s)" % (host, port, ver, ", via proxy" if proxy else "")
    except ssl.SSLError as e:
        return False, "%s:%d TLS failed: %s" % (host, port, e)
    except (socket.error, socket.timeout) as e:
        return False, "%s:%d %s%s" % (host, port, e, " (via proxy)" if proxy else "")


def _host(url):
    h, p = netcheck._host_of(url)
    return h, p


def run(site, role, me, profile, runner, as_cflex=None, send_test=False, connect=None):
    """→ [Result]. `connect` lets tests replace tcp/tls."""
    tcp_f = (connect or {}).get("tcp", tcp)
    tls_f = (connect or {}).get("tls", tls)
    out = []
    add = lambda n, good, d, warn=False: out.append(Result(n, "PASS" if good else ("WARN" if warn else "FAIL"), d))

    # services
    from .deploy import CONTAINERS, BARE_UNITS
    if profile == "container":
        names = [n for n in CONTAINERS[role] if n != "cflex-redis" or (siteconf.redis_host(site) or {}).get("id") == me[1]]
        for n in names:
            r = as_cflex(["podman", "healthcheck", "run", n], mutating=False) if as_cflex else (1, "", "no runner")
            add("service " + n, ok(r), "healthy" if ok(r) else (r[2] or r[1] or "unhealthy").strip()[:200])
    else:
        for n in BARE_UNITS[role]:
            r = runner.run(["systemctl", "is-active", n + ".service"])
            add("service " + n, ok(r), r[1].strip() or r[2].strip())

    proxy = _parse_proxy(siteconf.get(site, "portal.proxy"))
    apps = siteconf.get(site, "hosts.app") or []
    console_ca = "/opt/app/cflex/certs/console-ca.pem"
    ca = console_ca if runner.exists(console_ca) else None

    if role == "collector":
        for a in apps:
            good, d = tls_f(a.get("ip"), 443, cafile=ca, verify=bool(ca))
            add("collector → %s 443" % a.get("id"), good, d + ("" if ca else " (no console-ca.pem: not verified)"))
    if role in ("collector", "app") and siteconf.get(site, "portal.enabled", True):
        h, p = _host(siteconf.get(site, "portal.url"))
        good, d = tls_f(h, p or 443, proxy=proxy)
        add("%s → portal %s" % (role, h), good, d + (" proxy %s" % redact(siteconf.get(site, "portal.proxy")) if proxy else ""))
    if role == "app":
        db = siteconf.get(site, "hosts.db") or {}
        good, d = tcp_f(db.get("ip"), db.get("port", 5432))
        # The console still runs on SQLite (WO-INT-008), so the DB link is not yet load-bearing.
        add("app → db %s" % db.get("port", 5432), good, d, warn=True)
        rh = siteconf.redis_host(site) or {}
        if rh.get("id") != me[1]:
            good, d = tcp_f(rh.get("ip"), 6379)
            add("app → redis on %s" % rh.get("id"), good, d)
        for a in apps:
            if a.get("id") != me[1]:
                good, d = tls_f(a.get("ip"), 443, cafile=ca, verify=bool(ca))
                add("app → peer %s 443" % a.get("id"), good, d)
    # Local notification paths. Spec §1 lists them for the app; today the collector's alarm
    # engine sends them (WO-INT-003), so both roles check whatever is configured (Q-2026-10-25-10).
    if role in ("app", "collector"):
        smtp = siteconf.get(site, "notify.smtp") or {}
        if smtp.get("host") and "<" not in str(smtp.get("host")):
            good, d = tcp_f(smtp["host"], smtp.get("port", 587), banner=True)
            add("%s → SMTP relay" % role, good, d)
        else:
            add("%s → SMTP relay" % role, False, "notify.smtp.host not set", warn=True)
        sn_h, sn_p = _host(siteconf.get(site, "notify.itsm.url"))
        if sn_h and "<" not in sn_h:
            good, d = tls_f(sn_h, sn_p or 443, proxy=proxy)
            add("%s → ServiceNow" % role, good, d)
        else:
            add("%s → ServiceNow" % role, False, "notify.itsm.url not set", warn=True)
        th, tp = _host(siteconf.get(site, "notify.teams.webhook"))
        if th and "<" not in th:
            good, d = tls_f(th, tp or 443, proxy=proxy if siteconf.get(site, "notify.teams.via_proxy", True) else None)
            add("%s → Teams" % role, good, d)
        else:
            add("%s → Teams" % role, False, "notify.teams.webhook not set", warn=True)

    if send_test:
        if role != "collector":
            add("send-test", False, "run --send-test on the collector (the alarm engine and test-ticket CLI live there)", warn=True)
        else:
            cmd = ["node", "/opt/cflex/probe-agent/bin/cflex-test-ticket.js"]
            r = as_cflex(["podman", "exec", "cflex-collector"] + cmd) if profile == "container" else \
                runner.run(["runuser", "-u", "cflex", "--", "node", "/opt/app/cflex/current/probe-agent/bin/cflex-test-ticket.js"], mutating=True)
            add("send-test (ServiceNow test ticket)", ok(r), (r[1] or r[2]).strip()[-300:])
    return out


def format_text(results, role, me):
    lines = ["# cflex verify — role=%s host=%s %s" % (role, me[1], me[2])]
    for r in results:
        lines.append("%-4s %-34s %s" % (r.verdict, r.name, r.detail))
    fails = sum(1 for r in results if r.verdict == "FAIL")
    lines.append("결과: %s — FAIL %d · WARN %d" % ("PASS" if not fails else "FAIL", fails, sum(1 for r in results if r.verdict == "WARN")))
    return "\n".join(lines) + "\n"
