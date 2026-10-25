"""Everything that touches the host goes through a Runner, so tests can swap in a fake.

Runner.run() returns (rc, stdout, stderr). Nothing here raises on a non-zero
exit: callers decide what a failure means. Every command is logged (argv only;
never stdin, never file contents — secrets pass through files, not argv).
Output is decoded as UTF-8 regardless of the locale (sudo with LANG=C gives
Python 3.6 an ASCII locale).
"""

import io
import os
import subprocess


def _text(b):
    return b.decode("utf-8", "replace") if isinstance(b, bytes) else (b or "")


class Runner(object):
    def __init__(self, log=None, dry_run=False):
        self.log = log
        self.dry_run = dry_run
        self.calls = []

    def _log(self, msg):
        if self.log:
            self.log(msg)

    def run(self, argv, input_text=None, env=None, mutating=False, timeout=600):
        self.calls.append(list(argv))
        if mutating and self.dry_run:
            self._log("[dry-run] " + " ".join(argv))
            return 0, "", ""
        self._log("$ " + " ".join(argv))
        e = None
        if env:
            e = dict(os.environ)
            e.update(env)
        try:
            p = subprocess.Popen(argv, stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=e)
        except OSError as ex:
            return 127, "", str(ex)
        data = input_text.encode("utf-8") if input_text is not None else None
        try:
            out, err = p.communicate(data, timeout=timeout)
        except subprocess.TimeoutExpired:
            p.kill()
            out, err = p.communicate()
            return 124, _text(out), _text(err) + "\ntimeout after %ss" % timeout
        return p.returncode, _text(out), _text(err)

    def read(self, path):
        try:
            with io.open(path, encoding="utf-8", errors="replace") as f:
                return f.read()
        except (IOError, OSError):
            return None

    def exists(self, path):
        return os.path.exists(path)

    def is_mount(self, path):
        return os.path.ismount(path)

    def write(self, path, content, mode=0o644, uid=None, gid=None):
        """Atomic write. Returns True if the file changed (idempotence: same content → no write)."""
        if self.read(path) == content and self._mode_ok(path, mode, uid, gid):
            return False
        if self.dry_run:
            self._log("[dry-run] write %s (%o)" % (path, mode))
            return True
        d = os.path.dirname(path)
        if d and not os.path.isdir(d):
            os.makedirs(d, 0o750)
        tmp = path + ".cflex-tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with io.open(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.chmod(tmp, mode)
        if uid is not None:
            os.chown(tmp, uid, gid if gid is not None else -1)
        os.rename(tmp, path)
        self._log("wrote %s (%o)" % (path, mode))
        return True

    def _mode_ok(self, path, mode, uid, gid):
        try:
            st = os.stat(path)
        except OSError:
            return False
        if (st.st_mode & 0o7777) != mode:
            return False
        if uid is not None and st.st_uid != uid:
            return False
        if gid is not None and st.st_gid != gid:
            return False
        return True

    def geteuid(self):
        return os.geteuid()


def ok(res):
    return res[0] == 0
