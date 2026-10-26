"""RHEL 8's platform-python is 3.6. Parse every installer module as 3.6 and reject 3.7+ library calls."""
import ast
import io
import os
import re
import sys
import unittest

from helpers import INSTALL

LIB = os.path.join(INSTALL, "lib")


def sources():
    for d, _, files in os.walk(LIB):
        for fn in files:
            if fn.endswith(".py"):
                p = os.path.join(d, fn)
                with io.open(p, encoding="utf-8") as f:
                    yield p, f.read()


class Py36(unittest.TestCase):
    def test_syntax(self):
        if sys.version_info < (3, 8):
            self.skipTest("ast feature_version needs Python 3.8+ to check")
        for p, src in sources():
            ast.parse(src, filename=p, feature_version=(3, 6))

    def test_no_37_apis(self):
        bad = [r"capture_output\s*=", r"\btext\s*=\s*True", r"from dataclasses", r"import dataclasses",
               r"\.removeprefix\(", r"\.removesuffix\(", r"asyncio\.run\(", r"datetime\.fromisoformat",
               r"\.reconfigure\("]
        for p, src in sources():
            for b in bad:
                self.assertIsNone(re.search(b, src), "%s uses %s" % (p, b))


if __name__ == "__main__":
    unittest.main()
