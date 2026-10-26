"""install / upgrade / rollback (spec 01 §3.3).

plan() lists every change before anything happens; apply() only runs with --yes.
Each step checks first and skips when the host already matches (idempotent:
a second install with the same bundle changes nothing).

Container profile: rootless Podman as `cflex`, Quadlet units in
~cflex/.config/containers/systemd, images from `podman load` only.
Bare profile: AppStream modules, /opt/app/cflex/releases/<ver> + `current`.
"""

import binascii
import json
import os
import pwd
import shutil
import stat
import time

from . import render, siteconf
from .sysrun import ok

BASE = render.BASE
STATE = BASE + "/state/deployed.json"
SYSCTL_FILE = "/etc/sysctl.d/90-cflex-unprivileged-ports.conf"
HEALTH_TIMEOUT_S = 300

CONTAINERS = {
    "collector": ["cflex-collector"],
    "app": ["cflex-web", "cflex-console", "cflex-redis"],
    "db": ["cflex-postgres"],
}
BARE_UNITS = {"collector": ["cflex-collector"], "app": ["cflex-app", "nginx"], "db": []}
BARE_MODULES = {"collector": ["nodejs:20"], "app": ["nodejs:20", "nginx:1.22", "redis:6"], "db": ["postgresql:16"]}
BARE_PACKAGES = {"collector": ["nodejs"], "app": ["nodejs", "nginx", "redis"], "db": ["postgresql-server"]}


class Step(object):
    def __init__(self, title, fn, changes=True):
        self.title, self.fn, self.changes = title, fn, changes


class DeployError(Exception):
    pass


class Ctx(object):
    """Everything a step needs: site, this host, bundle, runner, mode."""

    def __init__(self, site, role, me, profile, runner, bundle=None, podman_version="4.9",
                 ports_mode="forward", log=print, self_signed=False):
        self.site, self.role, self.me, self.profile = site, role, me, profile
        self.runner, self.bundle, self.podman_version = runner, bundle, podman_version
        self.ports_mode, self.log, self.self_signed = ports_mode, log, self_signed
        self.zone = siteconf.get(site, "install.firewall_zone", "public")

    # rootless helpers
    def uid(self):
        try:
            return pwd.getpwnam("cflex").pw_uid
        except KeyError:
            return None

    def home(self):
        try:
            return pwd.getpwnam("cflex").pw_dir
        except KeyError:
            return "/home/cflex"

    def as_cflex(self, argv, mutating=True, timeout=600):
        uid = self.uid()
        env = ["env", "XDG_RUNTIME_DIR=/run/user/%s" % uid, "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/%s/bus" % uid]
        return self.runner.run(["runuser", "-u", "cflex", "--"] + env + argv, mutating=mutating, timeout=timeout)

    def must(self, res, what):
        if not ok(res):
            raise DeployError("%s failed (rc %s): %s" % (what, res[0], (res[2] or res[1]).strip()[-500:]))
        return res


# ── shared steps ───────────────────────────────────────────────────────────

def _user(c):
    if ok(c.runner.run(["id", "-u", "cflex"])):
        return "exists"
    c.must(c.runner.run(["useradd", "--create-home", "--shell", "/sbin/nologin", "--comment", "C-Flex service", "cflex"], mutating=True), "useradd")
    return "created"


def _subids(c):
    done = []
    for f, flag in (("/etc/subuid", "--add-subuids"), ("/etc/subgid", "--add-subgids")):
        text = c.runner.read(f) or ""
        if any(l.split(":")[0] == "cflex" for l in text.splitlines()):
            continue
        top = 100000
        for l in text.splitlines():
            p = l.split(":")
            if len(p) == 3 and p[1].isdigit() and p[2].isdigit():
                top = max(top, int(p[1]) + int(p[2]))
        c.must(c.runner.run(["usermod", flag, "%d-%d" % (top, top + 65535), "cflex"], mutating=True), "usermod " + flag)
        done.append(f)
    return "added " + ", ".join(done) if done else "present"


def _linger(c):
    r = c.runner.run(["loginctl", "show-user", "cflex", "-p", "Linger", "--value"])
    if r[1].strip() == "yes":
        return "enabled"
    c.must(c.runner.run(["loginctl", "enable-linger", "cflex"], mutating=True), "enable-linger")
    if not c.runner.dry_run:
        for _ in range(20):
            if c.runner.exists("/run/user/%s" % c.uid()):
                break
            time.sleep(0.5)
    return "enabled now"


def dirs_for(role, profile):
    d = [(BASE, 0o755), (BASE + "/config", 0o750), (BASE + "/certs", 0o750), (BASE + "/secrets", 0o700),
         (BASE + "/log", 0o750), (BASE + "/state", 0o750)]
    if role == "collector":
        d += [(BASE + "/config/collector", 0o750), (BASE + "/secrets/collector", 0o700), (BASE + "/queue", 0o750)]
    if role == "app":
        d += [(BASE + "/config/app", 0o750), (BASE + "/config/nginx", 0o750), (BASE + "/config/redis", 0o750),
              (BASE + "/secrets/app", 0o700), (BASE + "/secrets/redis", 0o700), (BASE + "/data", 0o750),
              (BASE + "/redis", 0o750)]
    if role == "db":
        # WAL archive next to the base backups; the backup script and the postgresql.conf fragment (WO-INT-008).
        d += [(BASE + "/secrets/db", 0o700), ("/opt/data/pgsql", 0o700), (render.BACKUP_DIR, 0o750), (render.WAL_DIR, 0o750),
              (BASE + "/bin", 0o755), (BASE + "/config/db", 0o750), (render.PG_CFG_DIR, 0o750)]
    d += [(BASE + "/releases", 0o755)] if profile == "bare" else [(BASE + "/bundles", 0o750)]
    return d


def _dirs(c):
    """Create — and on every run correct — owner and mode of the directories cflex-install manages.

    Correcting existing ones matters: an earlier run as root (the log directory is made before
    anything else) can leave /opt/app/cflex root-owned, and rootless Podman running as cflex then
    cannot reach a single volume. Parents of /opt/app/cflex only get the search bit for others.
    """
    made, fixed = [], []
    uid = c.uid()
    p = os.path.dirname(BASE)
    while p not in ("/", ""):
        if c.runner.exists(p) and not c.runner.dry_run:
            st = os.stat(p)
            if not st.st_mode & stat.S_IXOTH:
                os.chmod(p, stat.S_IMODE(st.st_mode) | 0o011)
                fixed.append("%s +x" % p)
        p = os.path.dirname(p)
    for path, mode in dirs_for(c.role, c.profile):
        if not c.runner.exists(path):
            made.append(path)
            if not c.runner.dry_run:
                os.makedirs(path, mode)
        if c.runner.dry_run:
            continue
        st = os.stat(path)
        if stat.S_IMODE(st.st_mode) != mode:
            os.chmod(path, mode)
            if path not in made:
                fixed.append("%s %o" % (path, mode))
        if uid is not None and (st.st_uid != uid or st.st_gid != uid):
            os.chown(path, uid, uid)
            if path not in made:
                fixed.append("%s owner cflex" % path)
    out = []
    if made:
        out.append("created %d" % len(made))
    if fixed:
        out.append("corrected: " + ", ".join(fixed))
    return "; ".join(out) if out else "present"


def _secret_file(c, path, generate, peer_hint):
    if c.runner.exists(path):
        return False
    if not generate:
        raise DeployError("%s missing — copy it from %s (same value on both app nodes; never by e-mail/chat)" % (path, peer_hint))
    # No trailing newline: `podman secret create` passes the file byte for byte (POSTGRESQL_PASSWORD).
    val = binascii.hexlify(os.urandom(32)).decode()
    uid = c.uid()
    c.runner.write(path, val, mode=0o600, uid=uid, gid=uid)
    return True


def _secrets(c):
    made = []
    apps = siteconf.get(c.site, "hosts.app") or []
    active = next((a for a in apps if a.get("role") == "active"), {})
    is_active = active.get("id") == c.me[1]
    uid = c.uid()
    if c.role == "app":
        for fn in ("redis.pass", "console.key"):
            if _secret_file(c, BASE + "/secrets/app/" + fn, is_active, "%s:%s/secrets/app/%s" % (active.get("id"), BASE, fn)):
                made.append(fn)
        # Both app nodes run Redis (primary + replica, Q-2026-10-25-11): the same password is the
        # one clients use and the one the replica authenticates to the primary with — on either
        # node, since a promotion swaps the roles.
        # The console's PostgreSQL password is db01's (generated there, below): copied, never invented here.
        pg = BASE + "/secrets/app/pg.pass"
        if not c.runner.exists(pg):
            hint = "%s missing — copy it from %s:%s/secrets/db/pg.pass (same value on db01 and both app nodes; " \
                   "never by e-mail/chat), owner cflex, 0600" % (pg, "db01", BASE)
            if not c.runner.dry_run:
                raise DeployError(hint)
            made.append("pg.pass MISSING (dry run: %s)" % hint)
        pw = (c.runner.read(BASE + "/secrets/app/redis.pass") or "").strip()
        if c.runner.dry_run and not pw:
            pw = "dry-run"
        if c.runner.write(BASE + "/secrets/redis/auth.conf", "requirepass %s\nmasterauth %s\n" % (pw, pw), mode=0o600, uid=uid, gid=uid):
            made.append("redis auth.conf")
    if c.role == "db":
        for fn, name in (("pg.pass", "cflex-pg-password"), ("pg-admin.pass", "cflex-pg-admin-password")):
            path = BASE + "/secrets/db/" + fn
            if _secret_file(c, path, True, "-"):
                made.append(fn)
            if c.profile == "container" and not ok(c.as_cflex(["podman", "secret", "inspect", name], mutating=False)):
                c.must(c.as_cflex(["podman", "secret", "create", name, path]), "podman secret create " + name)
                made.append("podman secret " + name)
    return "created: " + ", ".join(made) if made else "present (values not shown)"


def _certs(c):
    """Certificates are HAEA's (console, internal CA) or the Portal's (device). Never invented silently."""
    if c.role == "app":
        crt, key = BASE + "/certs/console.crt", BASE + "/certs/console.key"
        if c.runner.exists(crt) and c.runner.exists(key):
            return "console.crt present"
        if not c.self_signed:
            raise DeployError("%s / %s missing — install the HAEA internal-CA certificate, or pass "
                              "--self-signed-console-cert for a staging install" % (crt, key))
        c.must(c.runner.run(["openssl", "req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "90",
                             "-subj", "/CN=%s" % c.me[2], "-addext", "subjectAltName=IP:%s" % c.me[2],
                             "-keyout", key, "-out", crt], mutating=True), "openssl self-signed")
        if not c.runner.dry_run:
            uid = c.uid()
            os.chown(key, uid, uid)
            os.chmod(key, 0o600)
            os.chown(crt, uid, uid)
            shutil.copyfile(crt, BASE + "/certs/console-ca.pem")
            os.chown(BASE + "/certs/console-ca.pem", uid, uid)
        return "self-signed (90 days) — replace with the HAEA CA certificate"
    if c.role == "collector":
        cert = siteconf.get(c.site, "portal.mtls_cert") or BASE + "/certs/device.pem"
        if c.runner.exists(cert):
            return "device certificate present"
        c.log("  ! %s missing — the Portal will refuse this node until the CSR is signed (contract §6)" % cert)
        return "device certificate missing (not fatal)"
    return "n/a"


def _render_files(c, version):
    files = render.render(c.site, c.role, c.me, version, profile=c.profile,
                          podman_version=c.podman_version, ports_mode=c.ports_mode, home=c.home())
    uid = c.uid()
    changed = []
    for path in sorted(files):
        content, mode = files[path]
        owner = None if path.startswith("/etc/") else uid
        if not c.runner.dry_run:
            d = os.path.dirname(path)
            if not os.path.isdir(d):
                os.makedirs(d, 0o750)
                if owner is not None:
                    # ~cflex/.config/containers/systemd and its parents must belong to cflex.
                    p = d
                    while p.startswith(c.home()) and p != c.home():
                        os.chown(p, owner, owner)
                        p = os.path.dirname(p)
        if c.runner.write(path, content, mode=mode, uid=owner, gid=owner):
            changed.append(path)
    return changed


def firewall_rules(c):
    """[(kind, value)] for firewall-cmd --add-<kind>=<value>. Only what request v3 lists; SSH is HAEA's.

    forward mode: the host never opens 1162/8443 itself — DNAT'd traffic is accepted by
    firewalld's conntrack rule — and a source restriction has to sit on the forward
    rule (a plain port rule would not stop the forward-port).
    """
    out = []
    fwd = c.ports_mode == "forward" and c.profile == "container"
    rich = 'rule family="ipv4" source address="%s" '
    if c.role == "collector":
        out.append(("forward-port", "port=162:proto=udp:toport=1162") if fwd else ("port", "162/udp"))
    if c.role == "app":
        apps = siteconf.get(c.site, "hosts.app") or []
        peers = ["%s/32" % a.get("ip") for a in apps if a.get("id") != c.me[1]]
        srcs = list(siteconf.get(c.site, "install.user_sources") or [])
        if srcs:
            for s in srcs + peers:  # the peer node's fallback hop arrives on 443 too (FW-7)
                if fwd:
                    out.append(("rich-rule", (rich % s) + 'forward-port port="443" protocol="tcp" to-port="8443"'))
                else:
                    out.append(("rich-rule", (rich % s) + 'port port="443" protocol="tcp" accept'))
        else:
            out.append(("forward-port", "port=443:proto=tcp:toport=8443") if fwd else ("service", "https"))
        # 6379 from the peer app node on both nodes: the replica dials the primary, and after a
        # promotion the roles are the other way round (FW-7 app01↔app02 6379).
        for p in peers:
            out.append(("rich-rule", (rich % p) + 'port port="6379" protocol="tcp" accept'))
    if c.role == "db":
        port = (siteconf.get(c.site, "hosts.db") or {}).get("port", 5432)
        for a in siteconf.get(c.site, "hosts.app") or []:
            out.append(("rich-rule", (rich % ("%s/32" % a.get("ip"))) + 'port port="%s" protocol="tcp" accept' % port))
    return out


def _firewall(c):
    if not ok(c.runner.run(["systemctl", "is-active", "firewalld"])):
        return "firewalld not active — skipped"
    wants = firewall_rules(c)
    fw = ["firewall-cmd", "--permanent", "--zone=" + c.zone]
    added = []
    for kind, val in wants:
        if ok(c.runner.run(["firewall-cmd", "--permanent", "--zone=" + c.zone, "--query-" + kind + "=" + val])):
            continue
        c.must(c.runner.run(fw + ["--add-" + kind + "=" + val], mutating=True), "firewall-cmd add " + val)
        added.append(val)
    if added:
        c.must(c.runner.run(["firewall-cmd", "--reload"], mutating=True), "firewall-cmd --reload")
    return "added: " + "; ".join(added) if added else "rules present"


def _sysctl(c):
    if not (c.profile == "container" and c.ports_mode == "sysctl" and c.role in ("collector", "app")):
        return "n/a (%s)" % c.ports_mode
    content = ("# cflex-install: rootless Podman publishes UDP 162 (trap) and TCP 443 (console).\n"
               "# Chosen because firewalld forward-port was not available — docs/install/CONTAINER_PROFILE.md §2.\n"
               "net.ipv4.ip_unprivileged_port_start=161\n")
    if c.runner.write(SYSCTL_FILE, content, mode=0o644):
        c.must(c.runner.run(["sysctl", "-p", SYSCTL_FILE], mutating=True), "sysctl")
        return "set 161"
    return "already 161"


def _load_images(c):
    """Rootless: cflex runs `podman load`, so the tar must be readable by cflex. The bundle often
    sits in an admin's home; each tar is copied to /opt/app/cflex/bundles/<ver>/ and checked again."""
    loaded = []
    stage = "%s/bundles/%s" % (BASE, c.bundle.version)
    uid = c.uid()
    for im in c.bundle.images_for(c.role):
        if ok(c.as_cflex(["podman", "image", "exists", im["ref"]], mutating=False)):
            continue
        src = im["path"]
        if not src.startswith(BASE + "/") and not c.runner.dry_run:
            if not os.path.isdir(stage):
                os.makedirs(stage, 0o750)
                os.chown(os.path.dirname(stage), uid, uid)
                os.chown(stage, uid, uid)
            dst = os.path.join(stage, os.path.basename(src))
            shutil.copyfile(src, dst)
            os.chown(dst, uid, uid)
            os.chmod(dst, 0o640)
            from .bundle import sha256_file
            if sha256_file(dst) != im["sha256"]:
                raise DeployError("%s: checksum changed while copying" % dst)
            src = dst
        c.must(c.as_cflex(["podman", "load", "-i", src], timeout=1800), "podman load " + im["name"])
        loaded.append(im["name"])
    return "loaded: " + ", ".join(loaded) if loaded else "all present"


def _units(c):
    if c.role == "app":
        names = ["cflex-web", "cflex-console", "cflex-redis"]
        if render.podman_major(c.podman_version) >= 5:
            return ["cflex-app-pod"] + names
        return names
    return CONTAINERS[c.role]


def _restart(c):
    c.must(c.as_cflex(["systemctl", "--user", "daemon-reload"]), "systemctl --user daemon-reload")
    for u in _units(c):
        c.must(c.as_cflex(["systemctl", "--user", "restart", u + ".service"]), "restart " + u)
    out = "restarted: " + ", ".join(_units(c))
    if c.role == "db":
        # The daily base backup (render._db_files), a user timer of cflex like the Quadlet units.
        c.must(c.as_cflex(["systemctl", "--user", "enable", "--now", "cflex-pg-backup.timer"]), "enable cflex-pg-backup.timer")
        out += "; cflex-pg-backup.timer enabled"
    return out


def wait_healthy(c, timeout=HEALTH_TIMEOUT_S, sleep=time.sleep, clock=time.time):
    if c.profile == "container":
        names = list(CONTAINERS[c.role])
    else:
        names = list(BARE_UNITS[c.role])
    if c.runner.dry_run:
        return True, "dry-run"
    end = clock() + timeout
    pending = list(names)
    while pending and clock() < end:
        for n in list(pending):
            if c.profile == "container":
                r = c.as_cflex(["podman", "healthcheck", "run", n], mutating=False)
            else:
                r = c.runner.run(["systemctl", "is-active", n + ".service"])
            if ok(r):
                pending.remove(n)
        if pending:
            sleep(5)
    return (not pending), ("healthy: " + ", ".join(names) if not pending else "unhealthy: " + ", ".join(pending))


def read_state(runner):
    txt = runner.read(STATE)
    return json.loads(txt) if txt else {}


def write_state(c, state):
    uid = c.uid()
    c.runner.write(STATE, json.dumps(state, indent=2, sort_keys=True) + "\n", mode=0o640, uid=uid, gid=uid)


# ── bare-profile steps ─────────────────────────────────────────────────────

def _bare_packages(c):
    mods, pkgs = BARE_MODULES[c.role], BARE_PACKAGES[c.role]
    missing = [p for p in pkgs if not ok(c.runner.run(["rpm", "-q", p]))]
    if not missing:
        return "installed"
    # Satellite AppStream only (spec §3.2) — no third-party repos, no NodeSource.
    c.must(c.runner.run(["dnf", "-y", "module", "enable"] + mods, mutating=True, timeout=1800), "dnf module enable")
    c.must(c.runner.run(["dnf", "-y", "install"] + missing, mutating=True, timeout=1800), "dnf install")
    return "installed: " + ", ".join(missing)


def _bare_release(c, version):
    tree = {"collector": "collector", "app": "console"}.get(c.role)
    if not tree:
        return "n/a"
    rel = "%s/releases/%s" % (BASE, version)
    if not c.runner.exists(rel):
        src = os.path.join(c.bundle.root, "app", tree)
        if not c.runner.dry_run:
            shutil.copytree(src, rel, symlinks=True)
        c.must(c.runner.run(["restorecon", "-R", rel], mutating=True), "restorecon")
    _switch_current(c, version)
    return "%s → current" % rel


def _switch_current(c, version):
    cur = BASE + "/current"
    if c.runner.dry_run:
        return
    tmp = cur + ".new"
    if os.path.lexists(tmp):
        os.remove(tmp)
    os.symlink("%s/releases/%s" % (BASE, version), tmp)
    os.rename(tmp, cur)


def _bare_selinux(c):
    if c.role != "app":
        return "n/a"
    r = c.runner.run(["getsebool", "httpd_can_network_connect"])
    if "on" in r[1]:
        return "httpd_can_network_connect already on"
    c.must(c.runner.run(["setsebool", "-P", "httpd_can_network_connect", "1"], mutating=True), "setsebool")
    return "httpd_can_network_connect on (nginx → 127.0.0.1:8080, peer 443)"


def _bare_restart(c):
    c.must(c.runner.run(["systemctl", "daemon-reload"], mutating=True), "daemon-reload")
    for u in BARE_UNITS[c.role]:
        c.must(c.runner.run(["systemctl", "enable", "--now", u + ".service"], mutating=True), "enable " + u)
        c.must(c.runner.run(["systemctl", "restart", u + ".service"], mutating=True), "restart " + u)
    if c.role == "db":
        c.must(c.runner.run(["systemctl", "enable", "--now", "cflex-pg-backup.timer"], mutating=True), "enable cflex-pg-backup.timer")
        return "cflex-pg-backup.timer enabled (PostgreSQL itself: docs/install/PG_BACKUP_RESTORE.md §1)"
    return "restarted: " + ", ".join(BARE_UNITS[c.role]) if BARE_UNITS[c.role] else "n/a"


# ── plans ──────────────────────────────────────────────────────────────────

def plan_install(c):
    v = c.bundle.version
    if c.profile == "container":
        return [
            Step("user cflex", _user),
            Step("subuid/subgid for rootless Podman", _subids),
            Step("loginctl enable-linger cflex", _linger),
            Step("directories under %s (owner cflex)" % BASE, _dirs),
            Step("secrets (0600, generated on the active node only)", _secrets),
            Step("certificates", _certs),
            Step("podman load images (%s)" % ", ".join(i["name"] for i in c.bundle.images_for(c.role)), _load_images),
            Step("render Quadlet units + config for %s" % v, lambda c: ("changed %d file(s)" % len(_render_files(c, v)))),
            Step("privileged ports: %s" % c.ports_mode, _sysctl),
            Step("firewalld (zone %s)" % c.zone, _firewall),
            Step("systemctl --user restart", _restart),
        ]
    return [
        Step("AppStream modules %s" % " ".join(BARE_MODULES[c.role]), _bare_packages),
        Step("user cflex", _user),
        Step("directories under %s" % BASE, _dirs),
        Step("secrets", _secrets),
        Step("certificates", _certs),
        Step("release %s/releases/%s + current" % (BASE, v), lambda c: _bare_release(c, v)),
        Step("render systemd units + config", lambda c: ("changed %d file(s)" % len(_render_files(c, v)))),
        Step("SELinux booleans", _bare_selinux),
        Step("firewalld (zone %s)" % c.zone, _firewall),
        Step("systemctl restart", _bare_restart),
    ]


def describe(c, steps, extra=()):
    lines = ["# cflex-install plan — role=%s profile=%s host=%s %s version=%s" %
             (c.role, c.profile, c.me[1], c.me[2], c.bundle.version if c.bundle else "?")]
    for i, s in enumerate(steps, 1):
        lines.append("  %2d. %s" % (i, s.title))
    if c.profile == "container":
        lines.append("  images: " + ", ".join("%s (%s)" % (i["ref"], i["tar"]) for i in c.bundle.images_for(c.role)))
    else:
        lines.append("  packages: dnf module enable %s; dnf install %s" % (" ".join(BARE_MODULES[c.role]), " ".join(BARE_PACKAGES[c.role])))
    lines.extend(extra)
    return "\n".join(lines) + "\n"


def apply(c, steps):
    for i, s in enumerate(steps, 1):
        c.log("[%d/%d] %s" % (i, len(steps), s.title))
        res = s.fn(c)
        c.log("       → %s" % (res if isinstance(res, str) else res))


PROMOTION_KEYS = ("redis_primary", "redis_promoted_at", "redis_previous_primary")


def check_promotion(c):
    """A node promoted by hand stays the Redis primary until site.yaml says so too.

    Without this, the next install/upgrade/rollback would render it as a replica of
    the old primary again — which, once that VM is back, wipes the sessions this
    node has been serving and copies the stale ones over.
    """
    if c.role != "app":
        return
    st = read_state(c.runner)
    rh = siteconf.redis_host(c.site) or {}
    if st.get("redis_primary") != c.me[1]:
        return
    if rh.get("id") == c.me[1]:
        # site.yaml has caught up: it carries the truth from here on.
        for k in PROMOTION_KEYS:
            st.pop(k, None)
        write_state(c, st)
        return
    raise DeployError("this node's Redis was promoted to primary at %s, but site.yaml still names %s "
                      "(install.redis_host) — set install.redis_host: %s in site.yaml on all four VMs first "
                      "(docs/install/REDIS_FAILOVER.md §3). If this node is meant to be the replica now, remove "
                      "redis_primary from %s and re-run." % (st.get("redis_promoted_at"), rh.get("id"), c.me[1], STATE))


def install(c):
    check_promotion(c)
    steps = plan_install(c)
    apply(c, steps)
    healthy, why = wait_healthy(c)
    st = read_state(c.runner)
    if st.get("version") != c.bundle.version:
        st = {"previous": st.get("version"), "version": c.bundle.version}
    st.update({"role": c.role, "profile": c.profile, "host": c.me[1], "bundle": c.bundle.root,
               "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "healthy": healthy})
    write_state(c, st)
    if not healthy:
        raise DeployError(why + " — see: runuser -u cflex -- podman logs <name> / journalctl _UID=<cflex uid>")
    return why


def check_standby_first(c, standby_done):
    """Spec §3.3: upgrade the Standby first. On the active node this needs --standby-done."""
    if c.role != "app":
        return
    me = next((a for a in siteconf.get(c.site, "hosts.app") or [] if a.get("id") == c.me[1]), {})
    if me.get("role") == "active" and not standby_done:
        raise DeployError("this is the ACTIVE app node — upgrade the standby first, check it with `verify`, "
                          "then re-run here with --standby-done")


def run_migrations(c, direction):
    """The schema is the console's: cflex-app applies db/migrations at start (schema_migrations,
    one advisory lock for both nodes). Nothing runs from here; this only says what will happen."""
    migs = (c.bundle.manifest.get("migrations") if c.bundle else None) or []
    if not migs:
        return "no migrations in this bundle"
    last = migs[-1].get("file") if isinstance(migs[-1], dict) else migs[-1]
    if direction == "down":
        # Migrations only add (tables, columns, partitions); the older console runs on the newer schema.
        # Going back past a migration is a restore (docs/install/PG_BACKUP_RESTORE.md), not a script.
        return "schema kept at %s (migrations are additive; a schema rollback is a restore — PG_BACKUP_RESTORE.md)" % last
    return "%d migration(s) up to %s — applied by cflex-app at start (advisory lock, schema_migrations)" % (len(migs), last)


def upgrade(c, standby_done=False):
    check_promotion(c)
    check_standby_first(c, standby_done)
    st = read_state(c.runner)
    old = st.get("version")
    if not old:
        raise DeployError("nothing deployed here (%s) — use install" % STATE)
    if old == c.bundle.version:
        return "already at %s" % old
    c.log("upgrade %s → %s (%s)" % (old, c.bundle.version, run_migrations(c, "up")))
    try:
        if c.profile == "container":
            apply(c, [Step("podman load", _load_images),
                      Step("render %s" % c.bundle.version, lambda c: "changed %d" % len(_render_files(c, c.bundle.version))),
                      Step("restart", _restart)])
        else:
            apply(c, [Step("release", lambda c: _bare_release(c, c.bundle.version)),
                      Step("render", lambda c: "changed %d" % len(_render_files(c, c.bundle.version))),
                      Step("restart", _bare_restart)])
        healthy, why = wait_healthy(c)
    except DeployError as e:
        healthy, why = False, str(e)
    if healthy:
        write_state(c, dict(st, previous=old, version=c.bundle.version, healthy=True, at=time.strftime("%Y-%m-%dT%H:%M:%S%z")))
        return "upgraded to %s — %s" % (c.bundle.version, why)
    c.log("! %s — automatic rollback to %s" % (why, old))
    _to_version(c, old)
    ok2, why2 = wait_healthy(c)
    write_state(c, dict(st, version=old, healthy=ok2, failed_upgrade=c.bundle.version, at=time.strftime("%Y-%m-%dT%H:%M:%S%z")))
    raise DeployError("upgrade to %s failed (%s); rolled back to %s — %s" % (c.bundle.version, why, old, why2))


def _to_version(c, version):
    if c.profile == "container":
        # Old images stay loaded after an upgrade; only the tags in the units change back.
        _render_files(c, version)
        _restart(c)
    else:
        _switch_current(c, version)
        _render_files(c, version)
        _bare_restart(c)


def rollback(c):
    check_promotion(c)
    st = read_state(c.runner)
    prev, cur = st.get("previous"), st.get("version")
    if not prev:
        raise DeployError("no previous version recorded in %s" % STATE)
    c.log("rollback %s → %s (%s)" % (cur, prev, run_migrations(c, "down")))
    _to_version(c, prev)
    healthy, why = wait_healthy(c)
    write_state(c, dict(st, version=prev, previous=cur, healthy=healthy, rolled_back_from=cur,
                        at=time.strftime("%Y-%m-%dT%H:%M:%S%z")))
    if not healthy:
        raise DeployError("rolled back to %s but %s" % (prev, why))
    return "rolled back to %s — %s" % (prev, why)


# ── Redis promotion (DECISIONS Q-2026-10-25-11 (A)) ────────────────────────
#
# Both app nodes run Redis: install.redis_host is the primary, the other node a
# replica of it. When the primary's VM is gone, `cflex-install promote --role
# app` on the other node makes its replica the primary and points its console
# at it — sessions made before the failure are still there. Manual on purpose:
# an automatic failover between two nodes with no third vote is how a split
# brain happens. docs/install/REDIS_FAILOVER.md is the procedure (SAT 6).

REDIS_CLI = ["podman", "exec", "cflex-redis", "/bin/sh", "/opt/app/cflex/config/redis-cli.sh"]


def redis_info(as_cflex):
    """`INFO replication` of this node's Redis → dict, or None if it does not answer."""
    r = as_cflex(REDIS_CLI + ["INFO", "replication"], mutating=False)
    if not ok(r):
        return None
    info = {}
    for line in r[1].splitlines():
        k, sep, v = line.strip().partition(":")
        if sep and not k.startswith("#"):
            info[k] = v
    return info or None


def plan_promote(c):
    rh = siteconf.redis_host(c.site) or {}
    return [
        "redis-cli REPLICAOF NO ONE on %s (its replica of %s becomes the primary, data kept)" % (c.me[1], rh.get("id")),
        "render redis.conf (no replicaof) and app.env (REDIS_URL → 127.0.0.1) as if install.redis_host were %s" % c.me[1],
        "systemctl --user restart cflex-console (it reconnects to the local Redis)",
        "record the promotion in %s — install/upgrade refuse to undo it until site.yaml says %s" % (STATE, c.me[1]),
    ]


def promote(c, force=False, probe=None):
    """Make this app node's Redis the primary. → message; DeployError when refused or failed.

    `probe(host, port) → (ok, detail)` checks whether the old primary still answers (verify.tcp).
    """
    if c.role != "app":
        raise DeployError("promote is for --role app (the Redis of the console's sessions)")
    if c.profile != "container":
        raise DeployError("bare profile: cflex-install does not manage Redis there — "
                          "follow docs/install/REDIS_FAILOVER.md §5 by hand")
    rh = siteconf.redis_host(c.site) or {}
    st = read_state(c.runner)
    if rh.get("id") == c.me[1]:
        return "%s is already the Redis primary (install.redis_host) — nothing to do" % c.me[1]
    info = redis_info(c.as_cflex)
    if info is None:
        raise DeployError("cflex-redis on %s does not answer — start it first "
                          "(runuser -u cflex -- systemctl --user start cflex-redis)" % c.me[1])
    if st.get("redis_primary") == c.me[1] and info.get("role") == "master":
        return "%s was already promoted at %s — nothing to do" % (c.me[1], st.get("redis_promoted_at"))
    if probe is not None and not force:
        up, detail = probe(rh.get("ip"), 6379)
        if up:
            raise DeployError("the primary %s still answers on 6379 (%s) — promoting now would leave two primaries. "
                              "Stop it or isolate its VM first; --force only if it answers but is known broken" % (rh.get("id"), detail))
    c.log("  %s Redis: role=%s link to %s=%s, last sync %ss ago" % (
        c.me[1], info.get("role"), rh.get("id"), info.get("master_link_status") or "-", info.get("master_last_io_seconds_ago", "?")))

    c.must(c.as_cflex(REDIS_CLI + ["REPLICAOF", "NO", "ONE"]), "redis-cli REPLICAOF NO ONE")
    # The files a restart reads: render this node as the primary, write only those two.
    site2 = json.loads(json.dumps(c.site))
    site2.setdefault("install", {})["redis_host"] = c.me[1]
    files = render.render(site2, "app", c.me, st.get("version") or "0.0.0-dev", profile=c.profile,
                          podman_version=c.podman_version, ports_mode=c.ports_mode, home=c.home())
    uid = c.uid()
    for path in (render.CONFIG + "/redis/redis.conf", render.CONFIG + "/app/app.env"):
        content, mode = files[path]
        c.runner.write(path, content, mode=mode, uid=uid, gid=uid)
    c.must(c.as_cflex(["systemctl", "--user", "restart", "cflex-console.service"]), "restart cflex-console")
    after = redis_info(c.as_cflex) or {}
    if not c.runner.dry_run and after.get("role") != "master":
        raise DeployError("Redis on %s still reports role=%s after REPLICAOF NO ONE" % (c.me[1], after.get("role")))
    st.update({"redis_primary": c.me[1], "redis_previous_primary": rh.get("id"),
               "redis_promoted_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
    write_state(c, st)
    return ("%s is now the Redis primary; its console uses it. Next (docs/install/REDIS_FAILOVER.md §3): "
            "set install.redis_host: %s in site.yaml on all four VMs, and before %s serves again run "
            "`cflex-install install --role app --yes` there so it comes back as a replica." % (c.me[1], c.me[1], rh.get("id")))
