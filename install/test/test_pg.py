"""WO-INT-008 — PostgreSQL 16 on db01: what the installer renders, checks and runs.

  render     postgresql.conf fragment (wal_level=replica, archiving) mounted into cflex-postgres,
             backup script + daily timer, app.env pointing both app nodes at db01 (password as a file)
  preflight  db: /opt/data writable and ours, 5432 open to the app nodes as /32 only
  verify     app: PG reachable, schema_migrations current, this/next month's partitions;
             db: last base backup within 14 days, wal_level/archive_mode
  backup     install/scripts/cflex-pg-backup.sh against a fake pg_basebackup on PATH:
             arguments, set naming, failure exit codes, 14-day retention, WAL pruning
"""
import io
import json
import os
import shutil
import stat
import subprocess
import tempfile
import time
import unittest

from helpers import FakeRunner, REPO, example_site, me
from cflex_install import deploy, preflight, render, verify

QD = "/home/cflex/.config/containers/systemd/"
SCRIPT = os.path.join(REPO, "install", "scripts", "cflex-pg-backup.sh")
CONF = render.PG_CFG_DIR + "/cflex-postgresql.conf"


class RenderDb(unittest.TestCase):
    def setUp(self):
        self.site = example_site()

    def test_container_db_gets_fragment_mount_script_and_user_timer(self):
        f = render.render(self.site, "db", me(self.site, "db", "db01"), "2.0.0")
        unit = f[QD + "cflex-postgres.container"][0]
        self.assertIn("Volume=%s:/opt/app-root/src/postgresql-cfg:ro,Z" % render.PG_CFG_DIR, unit)
        self.assertIn("Volume=/opt/data/backup:/opt/data/backup:Z", unit)
        conf = f[CONF][0]
        for line in ("wal_level = replica", "archive_mode = on",
                     "archive_command = 'test ! -f /opt/data/backup/wal/%f && cp %p /opt/data/backup/wal/%f'"):
            self.assertIn("\n" + line + "\n", conf)
        self.assertNotIn("repmgr", "\n".join(l for l in conf.splitlines() if not l.startswith("#")))
        script, mode = f[render.BACKUP_SCRIPT]
        self.assertEqual(mode, 0o755)
        with io.open(SCRIPT, encoding="utf-8") as s:
            self.assertEqual(script, s.read(), "the script is installed as it is in the repo")
        ud = "/home/cflex/.config/systemd/user/"
        svc, timer = f[ud + "cflex-pg-backup.service"][0], f[ud + "cflex-pg-backup.timer"][0]
        self.assertIn('Environment="CFLEX_PG_EXEC=/usr/bin/podman exec cflex-postgres"', svc)
        self.assertIn("Environment=CFLEX_BACKUP_KEEP_DAYS=14", svc)
        self.assertIn("After=cflex-postgres.service", svc)
        self.assertNotIn("User=", svc, "a user unit of cflex")
        self.assertIn("OnCalendar=*-*-* 02:30:00", timer)
        self.assertIn("Persistent=true", timer)

    def test_bare_db_system_units_run_as_postgres_with_data_on_opt_data(self):
        f = render.render(self.site, "db", me(self.site, "db", "db01"), "2.0.0", profile="bare")
        svc = f["/etc/systemd/system/cflex-pg-backup.service"][0]
        self.assertIn("User=postgres\nGroup=postgres\n", svc)
        self.assertIn('Environment="CFLEX_PG_EXEC="', svc)
        self.assertIn("Environment=PGDATA=/opt/data/pgsql/data", f["/etc/systemd/system/postgresql.service.d/cflex.conf"][0])
        self.assertIn(CONF, f)

    def test_app_env_points_both_nodes_at_db01_password_as_a_file(self):
        for hid in ("app01", "app02"):
            for profile, secrets in (("container", "/opt/app/cflex/secrets"), ("bare", "/opt/app/cflex/secrets/app")):
                env = render.render(self.site, "app", me(self.site, "app", hid), "2.0.0", profile=profile)["/opt/app/cflex/config/app/app.env"][0]
                for line in ("CFLEX_DB_HOST=10.138.14.69", "CFLEX_DB_PORT=5432", "CFLEX_DB_NAME=cflex", "CFLEX_DB_USER=cflex",
                             "CFLEX_DB_PASSWORD_FILE=%s/pg.pass" % secrets, "CFLEX_RETENTION_RAW_YEARS=3",
                             "CFLEX_RETENTION_AGGREGATE_YEARS=10", "CFLEX_RETENTION_EVENTS_YEARS=10"):
                    self.assertIn("\n" + line + "\n", env, (hid, profile, line))
                self.assertNotIn("CFLEX_DB_URL", env)

    def test_retention_from_site_yaml_and_refused_when_nonsense(self):
        self.site["retention"] = {"raw_years": 5, "aggregate_years": 12, "events_years": 11}
        env = render.render(self.site, "app", me(self.site, "app", "app01"), "2.0.0")["/opt/app/cflex/config/app/app.env"][0]
        self.assertIn("CFLEX_RETENTION_RAW_YEARS=5\n", env)
        self.assertIn("CFLEX_RETENTION_EVENTS_YEARS=11\n", env)
        self.site["retention"]["raw_years"] = 0
        with self.assertRaises(render.RenderError):
            render.render(self.site, "app", me(self.site, "app", "app01"), "2.0.0")

    def test_db_dirs_include_wal_archive_and_config(self):
        paths = dict(deploy.dirs_for("db", "container"))
        self.assertEqual(paths["/opt/data/backup/wal"], 0o750)
        self.assertEqual(paths["/opt/data/pgsql"], 0o700)
        self.assertEqual(paths[render.PG_CFG_DIR], 0o750)


class DeployDb(unittest.TestCase):
    def ctx(self, role, hid, r, bundle=None):
        return deploy.Ctx(example_site(), role, me(example_site(), role, hid), "container", r, bundle=bundle, log=lambda m: None)

    def test_app_needs_db01_password_copied_not_invented(self):
        r = FakeRunner(dry_run=False, files={deploy.BASE + "/secrets/app/redis.pass": "pw", deploy.BASE + "/secrets/app/console.key": "k"})
        with self.assertRaises(deploy.DeployError) as cm:
            deploy._secrets(self.ctx("app", "app01", r))
        self.assertIn("copy it from db01", str(cm.exception))
        self.assertNotIn(deploy.BASE + "/secrets/app/pg.pass", r.writes)
        # A dry run says so instead of stopping.
        out = deploy._secrets(self.ctx("app", "app01", FakeRunner(dry_run=True)))
        self.assertIn("pg.pass MISSING", out)

    def test_db_restart_enables_the_backup_timer(self):
        r = FakeRunner(answers={"systemctl": (0, "", "")})
        c = self.ctx("db", "db01", r)
        c.as_cflex = lambda argv, mutating=True, timeout=600: r.run(argv)
        out = deploy._restart(c)
        self.assertIn(["systemctl", "--user", "enable", "--now", "cflex-pg-backup.timer"], r.calls)
        self.assertIn("cflex-pg-backup.timer enabled", out)

    def test_migrations_are_the_consoles_up_is_reported_down_keeps_the_schema(self):
        class B(object):
            version = "2.0.0"
            manifest = {"migrations": [{"file": "0001_init.sql", "sha256": "x"}]}
        c = self.ctx("app", "app02", FakeRunner(), bundle=B())
        self.assertIn("applied by cflex-app at start", deploy.run_migrations(c, "up"))
        self.assertIn("schema kept at 0001_init.sql", deploy.run_migrations(c, "down"))


def db_host(extra=None):
    answers = {
        "ip -o -4 addr show": (0, "2: eth0    inet 10.138.14.69/24 brd x scope global eth0\n", ""),
        "hostname -s": (0, "haeipfmsdb01v\n", ""),
        "getenforce": (0, "Enforcing\n", ""),
        "systemctl is-active firewalld": (0, "active\n", ""),
        "timedatectl show -p NTPSynchronized --value": (0, "yes\n", ""),
        "df -P -k": (0, "Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 524288000 1000 520000000 1% /opt/data\n", ""),
        "id -u cflex": (0, "1001\n", ""),
        "podman --version": (0, "podman version 4.9.4-rhel\n", ""),
        "rpm -q": (0, "pkg-1.0\n", ""),
        "loginctl show-user cflex -p Linger --value": (0, "yes\n", ""),
        "ss -H -n -l -t -u -p": (0, "", ""),
        "findmnt -n -o OPTIONS --target /opt/data": (0, "rw,relatime,seclabel\n", ""),
    }
    answers.update(extra or {})
    from helpers import OS_RELEASE_RHEL810
    return FakeRunner(answers=answers, files={"/etc/os-release": OS_RELEASE_RHEL810, "/etc/subuid": "cflex:100000:65536\n"},
                      mounts={"/opt/data"})


class PreflightDb(unittest.TestCase):
    def checks(self, r, site=None):
        c, _, _ = preflight.run(site or example_site(), "db", "container", r)
        return {x.name: (x.verdict, x.detail) for x in c}

    def test_ready_db_host_passes_read_only(self):
        r = db_host()
        got = self.checks(r)
        self.assertEqual([k for k, v in got.items() if v[0] == "FAIL"], [])
        self.assertEqual(got["5432 peers"], ("PASS", "tcp/5432 ← 10.138.14.67/32 (app01), 10.138.14.68/32 (app02) only"))
        self.assertEqual(got["/opt/data writable"][0], "PASS")
        for argv in r.calls:
            self.assertIn(argv[0], preflight.READ_ONLY_COMMANDS, argv)

    def test_read_only_mount_fails_and_foreign_data_dir_warns(self):
        got = self.checks(db_host({"findmnt -n -o OPTIONS --target /opt/data": (0, "ro,relatime\n", ""),
                                   "stat -c %U %a /opt/data/pgsql": (0, "postgres 700\n", "")}))
        self.assertEqual(got["/opt/data writable"][0], "FAIL")
        self.assertEqual(got["perm /opt/data/pgsql"][0], "WARN")

    def test_an_app_entry_that_is_not_one_address_fails(self):
        site = example_site()
        site["hosts"]["app"][1]["ip"] = "10.138.14.0/24"
        self.assertEqual(self.checks(db_host(), site)["5432 peers"][0], "FAIL")

    def test_netcheck_keeps_app_to_db_5432_inside_fw7(self):
        # Internal segment traffic: already in the v3 matrix as FW-7, nothing new for the request.
        with io.open(os.path.join(REPO, "install", "netmatrix.json"), encoding="utf-8") as f:
            nm = json.load(f)
        fw7 = [r for r in nm["rows"] if r["id"] == "FW-7"][0] if "rows" in nm else [r for r in nm if r.get("id") == "FW-7"][0]
        self.assertIn("app → db 5432", fw7["direction"])
        self.assertTrue(any(c.get("port") == 5432 and c.get("roles") == ["db"] for c in fw7["checks"]))


def status_json(**over):
    st = {"ok": True, "schema": {"applied": 1, "expected": 1, "pending": []},
          "partitions": {t: {"current": True, "next": True, "count": 4} for t in ("telemetry", "alarm_events", "audit_log")},
          "server": {"server_version": "16.4", "wal_level": "replica", "archive_mode": "on"},
          "archiver": {"archived": 12, "failed": 0, "last_archived_ms": 1}}
    st.update(over)
    return json.dumps(st)


class VerifyDb(unittest.TestCase):
    def run_app(self, cli_answer):
        site = example_site()
        calls = []

        def as_cflex(argv, mutating=True):
            calls.append(argv)
            if "db-status" in argv:
                return cli_answer
            return (0, "", "")
        out = verify.run(site, "app", me(site, "app", "app02"), "container", FakeRunner(), as_cflex=as_cflex,
                         connect={"tcp": lambda h, p, **k: (True, "%s:%s connected" % (h, p)), "tls": lambda *a, **k: (True, "ok")})
        return {r.name: (r.verdict, r.detail) for r in out}, calls

    def test_app_reads_schema_partitions_and_archiver_through_the_console(self):
        got, calls = self.run_app((0, status_json() + "\n", ""))
        self.assertIn(["podman", "exec", "cflex-console", "node", "/opt/cflex/apps/console/src/cli.js", "db-status"], calls)
        self.assertEqual(got["app → db 5432"][0], "PASS")
        self.assertEqual(got["app → db (PostgreSQL)"], ("PASS", "PostgreSQL 16.4, wal_level=replica, archive_mode=on"))
        self.assertEqual(got["db schema_migrations"], ("PASS", "version 1 of 1"))
        self.assertEqual(got["db month partitions"][0], "PASS")
        self.assertEqual(got["db WAL archiving"][0], "PASS")

    def test_pending_migration_and_missing_partition_fail_archive_failures_warn(self):
        got, _ = self.run_app((1, status_json(schema={"applied": 1, "expected": 2, "pending": ["0002_x.sql"]},
                                              partitions={"telemetry": {"current": True, "next": False}},
                                              archiver={"archived": 3, "failed": 2}), ""))
        self.assertEqual(got["db schema_migrations"], ("FAIL", "version 1 of 2 — pending: 0002_x.sql"))
        self.assertEqual(got["db month partitions"], ("FAIL", "missing: telemetry(next)"))
        self.assertEqual(got["db WAL archiving"][0], "WARN")

    def test_console_not_answering_is_a_failure(self):
        got, _ = self.run_app((125, "", "Error: no container with name or ID cflex-console"))
        self.assertEqual(got["app → db (PostgreSQL)"][0], "FAIL")

    def run_db(self, sets, now, psql=(0, "replica on\n", "")):
        files = {"%s/%s/CFLEX_BACKUP_OK" % (verify.BACKUP_DIR, s): "x" for s, complete in sets if complete}
        r = FakeRunner(answers={"ls -1 /opt/data/backup": (0, "\n".join(s for s, _ in sets) + "\nwal\nbackup.log\n", "")}, files=files)
        site = example_site()
        out = verify.run(site, "db", me(site, "db", "db01"), "container", r,
                         as_cflex=lambda argv, mutating=True: psql if argv[:3] == ["podman", "exec", "cflex-postgres"] else (0, "", ""), now=now)
        return {x.name: (x.verdict, x.detail) for x in out}

    def test_last_backup_age(self):
        now = time.mktime(time.strptime("20261026 09", "%Y%m%d %H")) - time.timezone
        self.assertEqual(self.run_db([("base-20261025", True), ("base-20261026", True)], now)["last base backup"],
                         ("PASS", "base-20261026, 0 day(s) old"))
        # Today's set without its OK marker is an interrupted run: the one before counts.
        self.assertEqual(self.run_db([("base-20261020", True), ("base-20261026", False)], now)["last base backup"][0], "WARN")
        self.assertEqual(self.run_db([("base-20261001", True)], now)["last base backup"][0], "FAIL")
        self.assertEqual(self.run_db([], now)["last base backup"][0], "FAIL")
        self.assertEqual(self.run_db([("base-20261026", True)], now)["db wal_level / archive_mode"][0], "PASS")
        self.assertEqual(self.run_db([("base-20261026", True)], now, psql=(0, "minimal off\n", ""))["db wal_level / archive_mode"][0], "FAIL")


FAKE_PG_BASEBACKUP = r"""#!/bin/bash
# Fake pg_basebackup: records its arguments, writes what -F tar -z writes.
echo "$@" >> "$FAKE_ARGS"
[[ -n "${FAKE_FAIL:-}" ]] && { echo "pg_basebackup: error: connection to server failed" >&2; exit 1; }
while [[ $# -gt 0 ]]; do case "$1" in -D) dir="$2"; shift 2;; *) shift;; esac; done
mkdir -p "$dir"
[[ -n "${FAKE_EMPTY:-}" ]] || echo data > "$dir/base.tar.gz"
echo wal > "$dir/pg_wal.tar.gz"
echo '{}' > "$dir/backup_manifest"
"""


@unittest.skipUnless(shutil.which("bash"), "bash not available")
class BackupScript(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.bin = os.path.join(self.tmp, "bin")
        self.dir = os.path.join(self.tmp, "backup")
        os.makedirs(self.bin)
        os.makedirs(self.dir)
        fake = os.path.join(self.bin, "pg_basebackup")
        with open(fake, "w") as f:
            f.write(FAKE_PG_BASEBACKUP)
        os.chmod(fake, 0o755)
        self.args = os.path.join(self.tmp, "args")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_script(self, day, **env):
        e = {"PATH": self.bin + os.pathsep + os.environ.get("PATH", "/usr/bin:/bin"), "CFLEX_BACKUP_DIR": self.dir,
             "CFLEX_BACKUP_DATE": day, "FAKE_ARGS": self.args}
        e.update(env)
        p = subprocess.Popen(["bash", SCRIPT], env=e, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        out, err = p.communicate()
        return p.returncode, out, err

    def test_bash_syntax(self):
        self.assertEqual(subprocess.call(["bash", "-n", SCRIPT]), 0)

    def test_makes_a_set_with_streamed_wal_and_is_idempotent_that_day(self):
        rc, out, _ = self.run_script("20261026")
        self.assertEqual(rc, 0, out)
        s = os.path.join(self.dir, "base-20261026")
        for fn in ("base.tar.gz", "pg_wal.tar.gz", "backup_manifest", "CFLEX_BACKUP_OK", "CFLEX_BACKUP_STARTED"):
            self.assertTrue(os.path.exists(os.path.join(s, fn)), fn)
        with open(self.args) as f:
            args = f.read().split()
        self.assertEqual(args[:2], ["-D", s + ".partial"])
        for a in ("-X", "stream", "-F", "tar", "-z", "--checkpoint=fast", "--label=cflex-20261026", "--no-password"):
            self.assertIn(a, args)
        self.assertTrue(os.path.isdir(os.path.join(self.dir, "wal")))
        self.assertIn("base-20261026 complete", out)
        rc, out, _ = self.run_script("20261026")
        self.assertEqual(rc, 0)
        self.assertIn("already complete", out)
        with open(self.args) as f:
            self.assertEqual(len(f.read().splitlines()), 1, "not run twice")
        with open(os.path.join(self.dir, "backup.log")) as f:
            self.assertIn("pg_basebackup →", f.read())

    def test_failure_exits_1_and_keeps_older_sets(self):
        self.assertEqual(self.run_script("20261025")[0], 0)
        rc, out, _ = self.run_script("20261026", FAKE_FAIL="1")
        self.assertEqual(rc, 1)
        self.assertIn("pg_basebackup failed (exit 1)", out)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "base-20261026.partial")))
        self.assertFalse(os.path.exists(os.path.join(self.dir, "base-20261026")))
        self.assertTrue(os.path.exists(os.path.join(self.dir, "base-20261025", "CFLEX_BACKUP_OK")))
        rc, out, _ = self.run_script("20261026", FAKE_EMPTY="1")
        self.assertEqual(rc, 1)
        self.assertIn("missing or empty", out)

    def test_configuration_problems_exit_2(self):
        self.assertEqual(self.run_script("20261026", CFLEX_BACKUP_DIR=os.path.join(self.tmp, "nope"))[0], 2)
        self.assertEqual(self.run_script("2026-10-26")[0], 2)
        self.assertEqual(self.run_script("20261026", CFLEX_BACKUP_KEEP_DAYS="0")[0], 2)

    def test_keeps_14_days_and_the_wal_the_oldest_kept_set_needs(self):
        wal = os.path.join(self.dir, "wal")
        os.makedirs(wal)
        # Sets from 20 days ago to yesterday, each started at noon of its day.
        base = time.mktime(time.strptime("20261026", "%Y%m%d"))
        for d in range(20, 0, -1):
            day = time.strftime("%Y%m%d", time.localtime(base - d * 86400))
            s = os.path.join(self.dir, "base-" + day)
            os.makedirs(s)
            open(os.path.join(s, "CFLEX_BACKUP_OK"), "w").close()
            st = os.path.join(s, "CFLEX_BACKUP_STARTED")
            open(st, "w").close()
            t = base - d * 86400 + 12 * 3600
            os.utime(st, (t, t))
            seg = os.path.join(wal, "0000000100000000%08X" % (100 - d))
            open(seg, "w").close()
            os.utime(seg, (t - 3600, t - 3600))   # archived an hour before that day's set started
        os.makedirs(os.path.join(self.dir, "base-20260101.partial"))
        rc, out, _ = self.run_script("20261026")
        self.assertEqual(rc, 0, out)
        sets = sorted(d for d in os.listdir(self.dir) if d.startswith("base-"))
        # Today minus 14 days … today: 15 sets (14 older + today's).
        self.assertEqual(sets[0], "base-20261012")
        self.assertEqual(len(sets), 15)
        self.assertNotIn("base-20260101.partial", sets)
        # WAL archived before the oldest kept set (20261012, 12:00) started is gone; from its day on it stays.
        left = sorted(os.listdir(wal))
        self.assertEqual(len(left), 13, left)   # the segments of 20261013 … 20261025
        self.assertIn("retention: 7 set(s) removed", out)

    def test_never_deletes_the_newest_complete_set_even_if_old(self):
        s = os.path.join(self.dir, "base-20260101")
        os.makedirs(s)
        open(os.path.join(s, "CFLEX_BACKUP_OK"), "w").close()
        rc, out, _ = self.run_script("20261026", FAKE_FAIL="1")
        self.assertEqual(rc, 1)
        self.assertTrue(os.path.isdir(s), "a failed run removes nothing")
        # A later good run: the old set may go, there is a newer complete one now.
        rc, out, _ = self.run_script("20261026")
        self.assertEqual(rc, 0)
        self.assertFalse(os.path.isdir(s))


if __name__ == "__main__":
    unittest.main()
