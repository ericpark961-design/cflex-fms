"""bundle.build against a fake podman. It builds from `git archive HEAD`, so run it on a committed tree."""
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest

from helpers import REPO
from cflex_install import bundle


class FakePodman(object):
    """Stands in for podman in bundle.build: records argv, writes a dummy tar for save, a tree for cp. git is real."""

    def __init__(self, node="20.20.2 115"):
        self.calls = []
        self.node = node  # what `node -e` prints inside our images: version and NODE_MODULE_VERSION

    def run(self, argv, input_text=None, env=None, mutating=False, timeout=600):
        self.calls.append(argv)
        if argv[0] == "git":
            p = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
            out, err = p.communicate()
            return p.returncode, out, err
        if argv[:3] == ["podman", "image", "inspect"]:
            return 0, ("sha256:" + "a" * 64) if "Digest" in argv[4] else ("sha256:" + "b" * 64), ""
        if argv[:2] == ["podman", "run"]:
            return 0, self.node + "\n", ""
        if argv[:2] == ["podman", "save"]:
            with open(argv[argv.index("-o") + 1], "wb") as f:
                f.write(b"tar:" + argv[-1].encode())
            return 0, "", ""
        if argv[:2] == ["podman", "cp"]:
            os.makedirs(os.path.join(argv[3], "probe-agent"))
            with open(os.path.join(argv[3], "probe-agent", "x.js"), "w") as f:
                f.write("1")
            return 0, "", ""
        return 0, "", ""


class Bundle(unittest.TestCase):
    def setUp(self):
        self.out = tempfile.mkdtemp()
        rc = subprocess.call(["git", "-C", REPO, "cat-file", "-e", "HEAD:images/base-images.env"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if rc != 0:
            self.skipTest("images/ not committed yet — bundle.build reads `git archive HEAD`")

    def tearDown(self):
        shutil.rmtree(self.out)

    def test_build_and_verify(self):
        fp = FakePodman()
        root = bundle.build(REPO, self.out, "2.0.0-test", runner=fp, log=lambda m: None, now="2026-10-25T00:00:00Z")
        with io.open(os.path.join(root, "MANIFEST.json"), encoding="utf-8") as f:
            m = json.load(f)
        names = [i["name"] for i in m["images"]]
        self.assertEqual(names, ["collector", "app", "web", "redis", "postgres"])
        self.assertTrue(all(i["base_digest"].startswith("sha256:") for i in m["images"]))
        self.assertEqual(m["signature"], "unsigned")
        self.assertEqual(m["sbom_status"], "stub")
        # better-sqlite3 loads in both node images, and they are Node 20 / ABI 115 (WO-INT-007).
        self.assertEqual(m["node"], {"major": 20, "abi": "115"})
        self.assertEqual({i["name"]: i.get("node") for i in m["images"]},
                         {"collector": {"version": "20.20.2", "abi": "115"}, "app": {"version": "20.20.2", "abi": "115"},
                          "web": None, "redis": None, "postgres": None})
        runs = [c for c in fp.calls if c[:2] == ["podman", "run"]]
        self.assertEqual([r[r.index("-w") + 1] for r in runs], ["/opt/cflex/probe-agent", "/opt/cflex/apps/console"])
        self.assertTrue(all("--network=none" in r and "better-sqlite3" in r[-1] for r in runs))
        builds = [c for c in fp.calls if c[:2] == ["podman", "build"]]
        self.assertEqual(len(builds), 3)
        for b in builds:
            self.assertIn("--format", b)
            self.assertTrue(any(a.startswith("BASE_IMAGE=") and "@sha256:" in a for a in b))
        b = bundle.Bundle(root)
        self.assertEqual(b.verify(), [])
        self.assertEqual([i["name"] for i in b.images_for("app")], ["app", "web", "redis"])
        with io.open(os.path.join(root, m["images"][0]["sbom"]), encoding="utf-8") as f:
            sb = json.load(f)
        self.assertEqual(sb["bomFormat"], "CycloneDX")
        self.assertIn("net-snmp", [c["name"] for c in sb["components"]])
        self.assertTrue(os.path.exists(os.path.join(root, "install", "cflex-install")))
        self.assertFalse(os.path.exists(os.path.join(root, "install", "test")))
        # tamper → detected
        with open(os.path.join(root, m["images"][0]["tar"]), "ab") as f:
            f.write(b"x")
        with open(os.path.join(root, "extra.txt"), "w") as f:
            f.write("x")
        probs = bundle.Bundle(root).verify()
        self.assertTrue(any("mismatch" in p for p in probs))
        self.assertTrue(any("extra.txt" in p for p in probs))

    def test_wrong_node_abi_is_refused(self):
        # An image on Node 22 (ABI 127) would carry a binary the Node 20 bare tree cannot load.
        with self.assertRaises(RuntimeError) as cm:
            bundle.build(REPO, self.out, "2.0.0-abi", runner=FakePodman(node="22.22.2 127"), log=lambda m: None)
        self.assertIn("must be Node 20, ABI 115", str(cm.exception))

    def test_native_module_that_does_not_load_is_refused(self):
        class Broken(FakePodman):
            def run(self, argv, **kw):
                if argv[:2] == ["podman", "run"]:
                    return 1, "", "Error: /lib64/libc.so.6: version `GLIBC_2.29' not found"
                return FakePodman.run(self, argv, **kw)
        with self.assertRaises(RuntimeError) as cm:
            bundle.build(REPO, self.out, "2.0.0-glibc", runner=Broken(), log=lambda m: None)
        self.assertIn("better-sqlite3 does not load", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
