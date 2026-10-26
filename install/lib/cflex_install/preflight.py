"""preflight — is this VM ready, and what will install do? (spec 01 §3.3)

No network calls: only local files, rpm/getenforce/systemctl/ss/ip queries.
test/test_preflight.py runs it against a fake host and checks that every
command it issued is on READ_ONLY_COMMANDS.
"""

import re

from . import netcheck, siteconf

READ_ONLY_COMMANDS = {
    "rpm", "getenforce", "systemctl", "timedatectl", "ip", "ss", "podman", "hostname",
    "id", "df", "loginctl", "firewall-cmd", "sysctl", "stat", "findmnt",
}

PODMAN_MIN = (4, 9)
MOUNTS = {"app": [("/opt/app", 50)], "db": [("/opt/data", 100)], "collector": [("/opt", 10)]}
PACKAGES = {
    # Podman 4.x publishes ports through slirp4netns, 5.x through pasta (package passt).
    "container": {4: ["podman", "slirp4netns", "container-selinux", "crun|runc", "fuse-overlayfs"],
                  5: ["podman", "passt", "container-selinux", "crun|runc"]},
    "bare": {"collector": ["nodejs"], "app": ["nodejs", "nginx", "redis"], "db": ["postgresql-server"]},
}


class Check(object):
    def __init__(self, name, verdict, detail):
        self.name, self.verdict, self.detail = name, verdict, detail

    def as_dict(self):
        return {"check": self.name, "verdict": self.verdict, "detail": self.detail}


def _ver(s):
    m = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", s or "")
    return tuple(int(x or 0) for x in m.groups()) if m else None


def os_release(text):
    kv = {}
    for line in (text or "").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            kv[k.strip()] = v.strip().strip('"')
    return kv


def local_ips(runner):
    rc, out, _ = runner.run(["ip", "-o", "-4", "addr", "show"])
    return re.findall(r"inet (\d+\.\d+\.\d+\.\d+)/", out) if rc == 0 else []


def podman_version(runner):
    rc, out, _ = runner.run(["podman", "--version"])
    return _ver(out) if rc == 0 else None


def firewalld_active(runner):
    rc, out, _ = runner.run(["systemctl", "is-active", "firewalld"])
    return out.strip() == "active"


def choose_ports_mode(site, runner):
    want = siteconf.get(site, "install.privileged_ports", "auto")
    if want != "auto":
        return want, "site.yaml install.privileged_ports=%s" % want
    if firewalld_active(runner):
        return "forward", "firewalld active → forward-port 162→1162, 443→8443 (host privileged-port boundary unchanged)"
    return "sysctl", "firewalld inactive → net.ipv4.ip_unprivileged_port_start=161"


def run(site, role, profile, runner, host_id=None, bundle=None):
    """→ (checks, me, facts). `me` is None when the host cannot be identified."""
    C = []
    add = lambda n, v, d: C.append(Check(n, v, d))
    facts = {}

    errs = siteconf.validate(site)
    add("site.yaml", "FAIL" if errs else "PASS", "; ".join(errs) if errs else "valid")

    osr = os_release(runner.read("/etc/os-release"))
    vid, oid = osr.get("VERSION_ID", ""), osr.get("ID", "")
    if oid == "rhel" and (vid == "8.10" or vid.startswith("9.")):
        add("os", "PASS", "%s %s" % (osr.get("NAME", oid), vid))
    elif oid in ("rhel", "rocky", "almalinux") and vid.split(".")[0] in ("8", "9"):
        add("os", "WARN", "%s %s — target is RHEL 8.10 (RHEL 9 compatible)" % (oid, vid))
    else:
        add("os", "FAIL", "%s %s — RHEL 8.10 / 9.x only" % (oid or "unknown", vid))

    add("root", "PASS" if runner.geteuid() == 0 else "FAIL",
        "running as root (sudo)" if runner.geteuid() == 0 else "run with sudo")

    me = None
    ips = local_ips(runner)
    try:
        me = siteconf.find_host(site, role, host_id, ips)
        add("host identity", "PASS", "%s %s (local: %s)" % (me[1], me[2], ", ".join(ips)))
    except siteconf.ConfigError as e:
        add("host identity", "FAIL", str(e))
    rc, hn, _ = runner.run(["hostname", "-s"])
    want_hn = (me[3] or {}).get("hostname") if me else None
    if want_hn:
        add("hostname", "PASS" if hn.strip() == want_hn else "FAIL", "%s (site.yaml: %s)" % (hn.strip(), want_hn))
    else:
        add("hostname", "PASS", "%s (site.yaml has no hostname to compare)" % hn.strip())

    # SELinux must stay Enforcing (spec §3.2: setenforce 0 is forbidden).
    rc, se, _ = runner.run(["getenforce"])
    se = se.strip()
    add("selinux", "PASS" if se == "Enforcing" else ("WARN" if se == "Permissive" else "FAIL"),
        se or "getenforce unavailable")

    fw = firewalld_active(runner)
    add("firewalld", "PASS" if fw else "WARN", "active" if fw else "not active — ports mode falls back to sysctl, no host firewall rules")

    rc, ntp, _ = runner.run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"])
    add("ntp", "PASS" if ntp.strip() == "yes" else "WARN", "synchronized" if ntp.strip() == "yes" else "not synchronized (%s)" % (ntp.strip() or "?"))

    for path, min_gb in MOUNTS.get(role, []):
        mounted = runner.is_mount(path)
        rc, df, _ = runner.run(["df", "-P", "-k", path])
        free_gb = None
        lines = df.strip().splitlines()
        if rc == 0 and len(lines) >= 2:
            try:
                free_gb = int(lines[-1].split()[3]) // (1024 * 1024)
            except (ValueError, IndexError):
                pass
        detail = "%s %s, free %s GB (min %d)" % (path, "is a mount" if mounted else "is NOT a separate mount", "?" if free_gb is None else free_gb, min_gb)
        v = "PASS"
        if role in ("app", "db") and not mounted:
            v = "WARN"
        if free_gb is not None and free_gb < min_gb:
            v = "FAIL"
        add("mount " + path, v, detail)

    rc_id, uid, _ = runner.run(["id", "-u", "cflex"])
    add("user cflex", "PASS" if rc_id == 0 else "WARN", "uid %s" % uid.strip() if rc_id == 0 else "will be created")

    if profile == "container":
        pv = podman_version(runner)
        facts["podman"] = ".".join(str(x) for x in pv) if pv else None
        if not pv:
            add("podman", "FAIL", "not installed — dnf module install container-tools (AppStream)")
        elif pv[:2] < PODMAN_MIN:
            add("podman", "FAIL", "%s < %d.%d (Quadlet keys used: UserNS keep-id:uid, Pull, Health*)" % (facts["podman"], PODMAN_MIN[0], PODMAN_MIN[1]))
        else:
            add("podman", "PASS", "%s — %s" % (facts["podman"], ".pod units" if pv[0] >= 5 else "no .pod in Quadlet 4.x: shared netns via cflex-web"))
        for spec in PACKAGES["container"][5 if pv and pv[0] >= 5 else 4]:
            names = spec.split("|")
            found = [n for n in names if runner.run(["rpm", "-q", n])[0] == 0]
            add("rpm " + spec, "PASS" if found else "FAIL", found[0] if found else "missing")
        if rc_id == 0:
            sub = runner.read("/etc/subuid") or ""
            has = any(l.split(":")[0] == "cflex" for l in sub.splitlines())
            add("subuid cflex", "PASS" if has else "WARN", "present" if has else "will be added (usermod --add-subuids)")
        rc2, lg, _ = runner.run(["loginctl", "show-user", "cflex", "-p", "Linger", "--value"])
        add("linger cflex", "PASS" if lg.strip() == "yes" else "WARN", "enabled" if lg.strip() == "yes" else "will be enabled (loginctl enable-linger cflex)")
        mode, why = choose_ports_mode(site, runner)
        facts["ports_mode"] = mode
        add("privileged ports", "PASS", "%s — %s" % (mode, why))
        if mode == "forward" and not fw:
            add("privileged ports", "FAIL", "forward mode needs firewalld")
    else:
        for n in PACKAGES["bare"].get(role, []):
            rc3, out, _ = runner.run(["rpm", "-q", n])
            if n == "nodejs" and rc3 == 0:
                # Exactly 20: the bundle's node_modules (better-sqlite3) are built for Node 20's ABI
                # (NODE_MODULE_VERSION 115) and do not load in 22 (127) — CONTAINER_PROFILE.md.
                v = _ver(out)
                add("rpm nodejs", "PASS" if v and v[0] == 20 else "FAIL",
                    out.strip() + ("" if v and v[0] == 20 else " — need dnf module nodejs:20 (the bundle is built for Node 20's ABI)"))
            else:
                add("rpm " + n, "PASS" if rc3 == 0 else "WARN", out.strip() if rc3 == 0 else "will be installed from AppStream (dnf module)")
        facts["ports_mode"] = "capability"

    # Ports this role will publish must be free (or already ours).
    if me:
        rc, lis, _ = runner.run(["ss", "-H", "-n", "-l", "-t", "-u", "-p"])
        wants = _ports_for(role, facts.get("ports_mode"), site, me)
        busy = ["%s/%d (%s)" % (l["proto"], l["lport"], ",".join(l["procs"]) or "?")
                for l in netcheck.parse_ss(lis)
                if (l["proto"], l["lport"]) in wants and not netcheck.cflex_owned(l["procs"])]
        add("ports free", "FAIL" if busy else "PASS",
            ", ".join(busy) if busy else "free: " + ", ".join("%s/%d" % w for w in wants))

    if bundle is not None:
        problems = bundle.verify()
        add("bundle checksums", "FAIL" if problems else "PASS", "; ".join(problems[:5]) if problems else "SHA256SUMS ok (%s)" % bundle.root)
        sig = bundle.signature_state()
        add("bundle signature", "PASS" if sig == "signed" else "WARN", sig)
        if profile == "container":
            missing = [i for i in bundle.images_for(role) if not runner.exists(i["path"])]
            add("bundle images", "FAIL" if missing else "PASS",
                "missing: " + ", ".join(i["name"] for i in missing) if missing else ", ".join(i["name"] for i in bundle.images_for(role)))
    return C, me, facts


def _ports_for(role, mode, site, me):
    hp = {"forward": (1162, 8443), "sysctl": (162, 443), "capability": (162, 443)}.get(mode, (162, 443))
    if role == "collector":
        return [("udp", hp[0])]
    if role == "app":
        # Redis on both app nodes: primary and replica (Q-2026-10-25-11 (A)).
        return [("tcp", hp[1]), ("tcp", 6379)]
    return [("tcp", int((siteconf.get(site, "hosts.db") or {}).get("port", 5432)))]


def format_text(checks, role, profile, me):
    lines = ["# cflex preflight — role=%s profile=%s host=%s" % (role, profile, "%s %s" % (me[1], me[2]) if me else "?")]
    for c in checks:
        lines.append("%-4s %-20s %s" % (c.verdict, c.name, c.detail))
    fails = sum(1 for c in checks if c.verdict == "FAIL")
    warns = sum(1 for c in checks if c.verdict == "WARN")
    lines.append("결과: %s — FAIL %d · WARN %d" % ("PASS" if not fails else "FAIL", fails, warns))
    return "\n".join(lines) + "\n"
