"""Entry for install/cflex-install and install/build-bundle under `python -I -B` (no PYTHONPATH, no .pyc).

stdout is forced to UTF-8: reports carry Korean and arrows, and `sudo` on a host with
LANG=C would otherwise give Python 3.6 an ASCII stdout.
"""
import io
import os
import runpy
import sys

if (getattr(sys.stdout, "encoding", "") or "").lower().replace("-", "") != "utf8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace", line_buffering=True)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
mod = sys.argv.pop(1)
runpy.run_module(mod, run_name="__main__", alter_sys=True)
