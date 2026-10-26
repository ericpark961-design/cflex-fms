"""netcheck — this host's real listeners and outbound connections vs firewall request v3.

Output is the §1 table, one row per firewall request row (direction / port /
purpose copied verbatim from install/netmatrix.json), so HAEA Security can lay
it next to request v3 and tick it off. Underneath each row, one line per check
with what was observed. Then everything observed that no row allows.

Passive: reads `ss` and local config. Name lookups (proxy, SMTP relay, …) use
the host resolver only for names in site.yaml; --no-resolve turns that off.

Verdicts: PASS · FAIL · WARN · N/A. Exit 1 when any FAIL.
  listen: PASS when bound on a non-loopback address (or, in forward mode, the
          unprivileged port is bound AND the firewalld forward rule exists).
  out:    PASS when the destination is configured; a live connection is shown
          when there is one. Not configured → WARN (FAIL if not optional and
          the role needs it).
  extra:  a listener or connection no row allows → FAIL if it belongs to
          C-Flex (podman/slirp4netns/node/nginx/redis/postgres), else WARN
          (HAEA base-image service, outside C-Flex — listed for the record).
"""

import io
import json
import os
import re
import socket

from . import siteconf

CFLEX_PROCS = ("slirp4netns", "rootlessport", "rootlessport-ch", "conmon", "podman", "pasta",
               "node", "nginx", "redis-server", "postgres", "postmaster")

_ADDR = re.compile(r"^(\[?[0-9a-fA-F:.*%a-zA-Z0-9]*\]?):(\d+|\*)$")


def _split_addr(tok):
    m = _ADDR.match(tok)
    if not m:
        return None
    host, port = m.group(1), m.group(2)
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    host = host.split("%")[0]
    return host, (None if port == "*" else int(port))


def parse_ss(text, default_proto=None):
    """Lines of `ss -H -n [-l] -t/-u -p` → [{proto, local, lport, peer, pport, procs}]."""
    out = []
    for line in (text or "").splitlines():
        toks = line.split()
        if not toks:
            continue
        proto = default_proto
        if toks[0] in ("tcp", "udp"):
            proto = toks[0]
        addrs = []
        for t in toks:
            a = _split_addr(t)
            if a:
                addrs.append(a)
        if len(addrs) < 2:
            continue
        procs = re.findall(r'\("([^"]+)",pid=', line)
        out.append({"proto": proto, "local": addrs[0][0], "lport": addrs[0][1],
                    "peer": addrs[1][0], "pport": addrs[1][1], "procs": sorted(set(procs))})
    return out


def is_loopback(ip):
    return ip.startswith("127.") or ip in ("::1", "localhost")


def cflex_owned(procs):
    return any(p in CFLEX_PROCS for p in procs)


# ── expectations ───────────────────────────────────────────────────────────

def _read_targets(path, runner):
    txt = runner.read(path) if path else None
    if txt is None:
        return None
    ips = []
    for line in txt.splitlines():
        line = line.split("#")[0].strip()
        if line:
            ips.append(line)
    return ips


def _host_of(url):
    m = re.match(r"^[a-z]+://(?:[^@/]*@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?", url or "")
    if not m:
        return None, None
    return m.group(1).strip("[]"), (int(m.group(2)) if m.group(2) else None)


def _placeholder(v):
    return v is None or (isinstance(v, str) and ("<" in v or v.strip() == ""))


def destinations(site, role, me, runner, resolve):
    """dest key → {'ips': set, 'ports': set|None, 'desc': str, 'configured': bool}."""
    d = {}

    def add(key, names, ports=None, desc="", configured=True):
        ips = set()
        shown = []
        for n in names:
            if _placeholder(n):
                continue
            shown.append(str(n))
            if re.match(r"^\d+\.\d+\.\d+\.\d+$", str(n)):
                ips.add(str(n))
            else:
                for ip in resolve(str(n)):
                    ips.add(ip)
        d[key] = {"ips": ips, "ports": set(ports) if ports else None,
                  "desc": desc or ", ".join(shown) or "미설정",
                  "configured": configured and bool(shown)}

    proxy_h, proxy_p = _host_of(siteconf.get(site, "portal.proxy"))
    proxied = not _placeholder(siteconf.get(site, "portal.proxy"))

    targets = _read_targets(siteconf.get(site, "nmc.targets_file"), runner)
    add("nmc", targets or [], desc=("NMC %d대 (%s)" % (len(targets), siteconf.get(site, "nmc.targets_file"))) if targets is not None
        else "nmc.targets_file 없음")

    portal_h, _ = _host_of(siteconf.get(site, "portal.url"))
    pin = siteconf.get(site, "portal.ip_pin")
    if siteconf.get(site, "portal.enabled", True):
        names = [pin or portal_h] + ([proxy_h] if proxied else [])
        ports = [443] + ([proxy_p] if proxied and proxy_p else [])
        add("portal", names, ports, desc="%s (%s)%s" % (portal_h, pin or "IP 미고정",
                                                         (" via proxy %s:%s" % (proxy_h, proxy_p)) if proxied else ""))
    else:
        add("portal", [], desc="portal.enabled=false", configured=False)

    apps = siteconf.get(site, "hosts.app") or []
    add("app", [a.get("ip") for a in apps], [443], desc="app " + ", ".join("%s %s" % (a.get("id"), a.get("ip")) for a in apps))
    peers = [a for a in apps if a.get("ip") != me[2]]
    add("peer_app", [a.get("ip") for a in peers], [443], desc="peer " + ", ".join("%s %s" % (a.get("id"), a.get("ip")) for a in peers))
    db = siteconf.get(site, "hosts.db") or {}
    add("db", [db.get("ip")], [db.get("port", 5432)], desc="db %s:%s" % (db.get("ip"), db.get("port", 5432)))
    rh = siteconf.redis_host(site) or {}
    add("redis", [rh.get("ip")], [6379], desc="redis on %s %s" % (rh.get("id"), rh.get("ip")))

    smtp = siteconf.get(site, "notify.smtp") or {}
    add("smtp", [smtp.get("host")], [smtp.get("port", 587)] if smtp.get("port") else [25, 587],
        desc="%s:%s" % (smtp.get("host"), smtp.get("port")))
    teams_via_proxy = siteconf.get(site, "notify.teams.via_proxy", True)
    teams = siteconf.get(site, "notify.teams.webhook")
    if teams_via_proxy and proxied:
        add("teams", [] if _placeholder(teams) else [proxy_h], [proxy_p] if proxy_p else None,
            desc="Teams via proxy %s:%s" % (proxy_h, proxy_p))
    else:
        th, _ = _host_of(teams)
        add("teams", [th], [443], desc="Teams %s" % th)
    sn = siteconf.get(site, "notify.itsm.url")
    sh, sp = _host_of(sn)
    if proxied:
        add("servicenow", [] if _placeholder(sn) else [proxy_h], [proxy_p] if proxy_p else None,
            desc="ServiceNow %s via proxy %s:%s" % (sh, proxy_h, proxy_p))
    else:
        add("servicenow", [sh], [sp or 443], desc="ServiceNow %s" % sh)

    # Satellite / DNS / NTP from the host's own config.
    plat = []
    rhsm = runner.read("/etc/rhsm/rhsm.conf") or ""
    m = re.search(r"^\s*hostname\s*=\s*(\S+)", rhsm, re.M)
    if m and m.group(1) != "subscription.rhsm.redhat.com":
        plat.append(m.group(1))
    for line in (runner.read("/etc/resolv.conf") or "").splitlines():
        p = line.split()
        if len(p) >= 2 and p[0] == "nameserver":
            plat.append(p[1])
    for line in (runner.read("/etc/chrony.conf") or "").splitlines():
        p = line.split()
        if len(p) >= 2 and p[0] in ("server", "pool"):
            plat.append(p[1])
    add("platform", plat, [443, 53, 123], desc="Satellite/DNS/NTP: " + (", ".join(plat) or "미설정"))
    return d


# ── evaluation ─────────────────────────────────────────────────────────────

def _applies(chk, role, me, site):
    if role not in chk["roles"]:
        return False
    if chk.get("redis_host_only"):
        rh = siteconf.redis_host(site) or {}
        return rh.get("id") == me[1]
    if chk.get("dest") == "redis":
        rh = siteconf.redis_host(site) or {}
        return rh.get("id") != me[1]
    return True


def evaluate(matrix, site, role, me, listeners, established, runner,
             forward_mode=False, forward_rules=(), resolve=None, installed=True):
    """Pure: inputs → report dict. `me` is siteconf.find_host()'s tuple."""
    resolve = resolve or (lambda n: [])
    dests = destinations(site, role, me, runner, resolve)
    public_listeners = [l for l in listeners if not is_loopback(l["local"])]
    used_listen, used_out = set(), set()
    rows = []
    for row in matrix["rows"]:
        lines = []
        for chk in row["checks"]:
            label = chk.get("label") or ("%s %s/%s" % (chk["type"], chk["proto"], chk.get("port") or chk.get("ports")))
            if not _applies(chk, role, me, site):
                # A row can say why it does not apply to a role (FW-8 on the collector: Q-2026-10-25-10).
                why = (chk.get("na") or {}).get(role) or "이 호스트(%s) 해당 없음" % role
                lines.append({"check": label, "verdict": "N/A", "observed": why})
                continue
            if chk["type"] == "listen":
                lines.append(_eval_listen(chk, label, public_listeners, used_listen, forward_mode, forward_rules, installed))
            else:
                lines.append(_eval_out(chk, label, dests, established, used_out))
        verdict = _worst([l["verdict"] for l in lines])
        rows.append({"id": row["id"], "direction": row["direction"], "port": row["port"],
                     "purpose": row["purpose"], "verdict": verdict, "checks": lines})

    extras = []
    for i, l in enumerate(public_listeners):
        if i in used_listen:
            continue
        own = cflex_owned(l["procs"])
        extras.append({"kind": "listen", "proto": l["proto"], "addr": "%s:%s" % (l["local"], l["lport"]),
                       "procs": l["procs"], "verdict": "FAIL" if own else "WARN",
                       "note": "C-Flex 리스너가 v3에 없음" if own else "C-Flex 외 서비스(HAEA 기본 이미지) — 기록용"})
    listen_ports = set((l["proto"], l["lport"]) for l in listeners)
    for i, c in enumerate(established):
        if i in used_out or is_loopback(c["peer"]):
            continue
        if (c["proto"], c["lport"]) in listen_ports:
            continue  # inbound to one of our listeners; judged by the listener row
        own = cflex_owned(c["procs"])
        extras.append({"kind": "out", "proto": c["proto"], "addr": "%s:%s" % (c["peer"], c["pport"]),
                       "procs": c["procs"], "verdict": "FAIL" if own else "WARN",
                       "note": "v3에 없는 아웃바운드 목적지" if own else "C-Flex 외 프로세스 — 기록용"})
    allv = [r["verdict"] for r in rows] + [e["verdict"] for e in extras]
    summary = dict((v, allv.count(v)) for v in ("PASS", "FAIL", "WARN", "N/A"))
    return {"role": role, "host_id": me[1], "host_ip": me[2], "matrix_source": matrix.get("source"),
            "privileged_ports": "forward" if forward_mode else "direct/sysctl",
            "rows": rows, "extras": extras, "summary": summary, "ok": summary["FAIL"] == 0}


_ORDER = {"FAIL": 3, "WARN": 2, "PASS": 1, "N/A": 0}


def _worst(vs):
    return max(vs, key=lambda v: _ORDER[v]) if vs else "N/A"


def _bound(listeners, used, proto, port):
    """Every socket on proto/port (IPv4 and IPv6 are separate lines) — all marked as accounted for."""
    hit = [i for i, l in enumerate(listeners) if l["proto"] == proto and l["lport"] == port]
    used.update(hit)
    if not hit:
        return None
    addrs = ", ".join("%s:%s" % (listeners[i]["local"], port) for i in hit)
    procs = sorted(set(p for i in hit for p in listeners[i]["procs"]))
    return "%s (%s)" % (addrs, ",".join(procs) or "?")


def _eval_listen(chk, label, listeners, used, forward_mode, forward_rules, installed):
    want = [chk["port"]]
    alt = chk.get("unprivileged_port")
    seen = _bound(listeners, used, chk["proto"], chk["port"])
    if seen:
        return {"check": label, "verdict": "PASS", "observed": "%s %s 리스닝" % (chk["proto"], seen)}
    if alt and forward_mode:
        seen = _bound(listeners, used, chk["proto"], alt)
        if seen:
            if (chk["proto"], chk["port"], alt) in forward_rules:
                return {"check": label, "verdict": "PASS",
                        "observed": "firewalld %s %s→%s, %s 리스닝" % (chk["proto"], chk["port"], alt, seen)}
            return {"check": label, "verdict": "FAIL",
                    "observed": "%s 리스닝하나 firewalld forward-port %s→%s 없음" % (seen, chk["port"], alt)}
        want.append(alt)
    if chk.get("system"):
        return {"check": label, "verdict": "WARN", "observed": "%s %s 리스너 없음 (OS 서비스)" % (chk["proto"], chk["port"])}
    return {"check": label, "verdict": "FAIL" if installed else "WARN",
            "observed": "%s %s 리스너 없음%s" % (chk["proto"], "/".join(str(w) for w in want), "" if installed else " (미설치)")}


def _eval_out(chk, label, dests, established, used):
    d = dests.get(chk["dest"])
    if not d or not d["configured"]:
        v = "WARN" if (chk.get("optional") or chk.get("system")) else "FAIL"
        if chk["dest"] in ("smtp", "teams", "servicenow"):
            v = "WARN"  # channel off by policy is legitimate
        return {"check": label, "verdict": v, "observed": "목적지 미설정: %s" % (d["desc"] if d else chk["dest"])}
    ports = d["ports"] or set(chk["ports"])
    live = []
    for i, c in enumerate(established):
        if c["peer"] in d["ips"] and (c["pport"] in ports or c["pport"] in chk["ports"]):
            used.add(i)
            live.append("%s:%s" % (c["peer"], c["pport"]))
    obs = d["desc"]
    if live:
        obs += " — 연결 %d건 (%s)" % (len(live), ", ".join(sorted(set(live))[:4]))
    elif d["ips"]:
        obs += " — 현재 연결 없음"
    else:
        obs += " — 주소 미해석"
    return {"check": label, "verdict": "PASS", "observed": obs}


# ── collection & output ────────────────────────────────────────────────────

def collect(runner):
    rc1, lis, _ = runner.run(["ss", "-H", "-n", "-l", "-t", "-u", "-p"])
    rc2, est_t, _ = runner.run(["ss", "-H", "-n", "-t", "-p", "state", "established"])
    if rc1 != 0 or rc2 != 0:
        raise RuntimeError("ss failed (is iproute installed, running as root?)")
    return parse_ss(lis), parse_ss(est_t, default_proto="tcp")


def parse_forward_rules(forward_ports, rich_rules):
    """(proto, port, toport) from `--list-forward-ports` and source-restricted rich-rule forward-ports."""
    rules = set()
    for tok in (forward_ports or "").split():
        m = re.match(r"port=(\d+):proto=(\w+):toport=(\d+)", tok)
        if m:
            rules.add((m.group(2), int(m.group(1)), int(m.group(3))))
    for line in (rich_rules or "").splitlines():
        m = re.search(r'forward-port port="(\d+)" protocol="(\w+)" to-port="(\d+)"', line)
        if m:
            rules.add((m.group(2), int(m.group(1)), int(m.group(3))))
    return rules


def forward_rules(runner, zone):
    rc1, fp, _ = runner.run(["firewall-cmd", "--zone=" + zone, "--list-forward-ports"])
    rc2, rr, _ = runner.run(["firewall-cmd", "--zone=" + zone, "--list-rich-rules"])
    return parse_forward_rules(fp if rc1 == 0 else "", rr if rc2 == 0 else "")


def default_resolver(name):
    try:
        return sorted(set(ai[4][0] for ai in socket.getaddrinfo(name, None, socket.AF_INET)))
    except socket.gaierror:
        return []


def load_matrix(path=None):
    path = path or os.path.join(os.path.dirname(__file__), "..", "..", "netmatrix.json")
    with io.open(path, encoding="utf-8") as f:
        return json.load(f)


def format_text(rep):
    out = []
    out.append("# cflex netcheck — role=%s host=%s (%s) — 기준: %s" % (rep["role"], rep["host_id"], rep["host_ip"], rep["matrix_source"]))
    out.append("# 특권 포트 처리: %s" % rep["privileged_ports"])
    out.append("")
    out.append("| ID | 방향 | 포트 | 용도 | 판정 |")
    out.append("|---|---|---|---|---|")
    for r in rep["rows"]:
        out.append("| %s | %s | %s | %s | %s |" % (r["id"], r["direction"], r["port"], r["purpose"], r["verdict"]))
    out.append("")
    for r in rep["rows"]:
        for c in r["checks"]:
            out.append("%-5s %-4s %-30s %s" % (r["id"], c["verdict"], c["check"], c["observed"]))
    out.append("")
    if rep["extras"]:
        out.append("## v3에 없는 리스너/연결")
        for e in rep["extras"]:
            out.append("EXTRA %-4s %-6s %-3s %-24s %-24s %s" % (e["verdict"], e["kind"], e["proto"], e["addr"], ",".join(e["procs"]) or "?", e["note"]))
    else:
        out.append("## v3에 없는 리스너/연결: 없음")
    s = rep["summary"]
    out.append("")
    out.append("결과: %s — PASS %d · FAIL %d · WARN %d · N/A %d" % ("PASS" if rep["ok"] else "FAIL", s["PASS"], s["FAIL"], s["WARN"], s["N/A"]))
    return "\n".join(out) + "\n"
