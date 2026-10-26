"""build-bundle CLI — run at RingOn on a RHEL build host with Podman and registry access.

  install/build-bundle --version 2.0.0 --out /srv/bundles [--gpg-key KEYID] [--ref HEAD]

Builds the three C-Flex images from `git archive <ref>` (never the working tree),
pulls the Red Hat bases by digest, saves everything with `podman save`, copies
the bare-profile trees out of the images, writes SBOM stubs, MANIFEST.json and
SHA256SUMS, and signs SHA256SUMS when a GPG key is given.
"""

import argparse
import os
import sys

from . import bundle


def main(argv=None):
    ap = argparse.ArgumentParser(prog="build-bundle")
    ap.add_argument("--version", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--ref", default="HEAD")
    ap.add_argument("--repo", default=os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "..")))
    ap.add_argument("--gpg-key", default=None)
    ap.add_argument("--podman", default="podman")
    ap.add_argument("--no-build", action="store_true", help="package images already built and tagged locally")
    ap.add_argument("--tar", action="store_true", help="also write cflex-bundle-<version>.tar next to the directory")
    a = ap.parse_args(argv)
    try:
        root = bundle.build(a.repo, a.out, a.version, podman=a.podman, git_ref=a.ref,
                            build_images=not a.no_build, gpg_key=a.gpg_key)
    except RuntimeError as e:
        print("build-bundle: %s" % e, file=sys.stderr)
        return 1
    if a.tar:
        import tarfile
        with tarfile.open(root + ".tar", "w") as t:
            t.add(root, arcname=os.path.basename(root))
        print(root + ".tar")
    print(root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
