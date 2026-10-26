"""Shared fakes for the installer tests.  From the repository root:

    python3 -m unittest discover -s install/test

(the start directory goes on sys.path, so `from helpers import …` works; do not pass -t install —
install/test has no __init__.py and `test` would collide with the standard library package).
"""
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
INSTALL = os.path.dirname(HERE)
REPO = os.path.dirname(INSTALL)
sys.path.insert(0, os.path.join(INSTALL, "lib"))

from cflex_install import siteconf  # noqa: E402


def example_site():
    with io.open(os.path.join(INSTALL, "site.example.yaml"), encoding="utf-8") as f:
        return siteconf.loads(f.read())


def me(site, role, hid):
    return siteconf.find_host(site, role, hid, ())


class FakeRunner(object):
    """Answers commands from a table; records every call. Files come from a dict."""

    def __init__(self, answers=None, files=None, mounts=(), euid=0, dry_run=False):
        self.answers = answers or {}
        self.files = dict(files or {})
        self.mounts = set(mounts)
        self.euid = euid
        self.dry_run = dry_run
        self.calls = []
        self.writes = {}

    def run(self, argv, input_text=None, env=None, mutating=False, timeout=600):
        self.calls.append(list(argv))
        key = " ".join(argv)
        for k in sorted(self.answers, key=len, reverse=True):
            if key == k or key.startswith(k + " ") or key.endswith(" " + k) or (" " + k + " ") in (" " + key + " "):
                v = self.answers[k]
                return v(argv) if callable(v) else v
        return (1, "", "not faked: " + key)

    def read(self, path):
        return self.files.get(path)

    def exists(self, path):
        return path in self.files or path in self.writes

    def is_mount(self, path):
        return path in self.mounts

    def write(self, path, content, mode=0o644, uid=None, gid=None):
        changed = self.files.get(path) != content
        self.writes[path] = (content, mode)
        self.files[path] = content
        return changed

    def geteuid(self):
        return self.euid


OS_RELEASE_RHEL810 = 'NAME="Red Hat Enterprise Linux"\nID="rhel"\nVERSION_ID="8.10"\n'
