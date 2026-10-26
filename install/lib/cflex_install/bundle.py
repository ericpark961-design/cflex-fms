"""Offline bundle — build it at RingOn, verify and read it on site (spec 01 §3.1, §3.3).

Layout (cflex-bundle-<version>/):
  MANIFEST.json        what is in here: images (ref, tar, sha256, base digest, roles), git commit, build time
  SHA256SUMS           every other file, `sha256sum -c` format
  SHA256SUMS.asc       detached GPG signature (when built with --gpg-key)
  images/*.tar         `podman save` archives — the site only runs `podman load`
  app/{collector,console}/   the same /opt/cflex trees, copied out of the images (bare profile)
  sbom/*.cdx.json      CycloneDX per image — STUB (npm ranges from package.json, see properties)
  sbom/VULN-SCAN.txt   scan report placeholder (not performed by this script)
  install/             cflex-install + templates + netmatrix.json
  config/              site.example.yaml, nmc-targets.example.txt
  db/migrations/       forward + rollback scripts (none yet — WO-INT-008)
  docs/                docs/install/*.md
"""

import datetime
import hashlib
import io
import json
import os
import shutil
import tarfile
import tempfile
import uuid

from .sysrun import Runner

# Our three images are built here; the two Red Hat images are referenced, pulled by digest and
# re-tagged unmodified so the site sees one naming scheme (cflex/<name>:<version>).
OWN = [
    {"name": "collector", "containerfile": "images/collector/Containerfile", "roles": ["collector"],
     "base_var": "UBI8_NODEJS_20", "packages": ["probe-agent", "packages/notify"], "node_tree": "/opt/cflex/probe-agent"},
    {"name": "app", "containerfile": "images/app/Containerfile", "roles": ["app"],
     "base_var": "UBI8_NODEJS_20", "packages": ["apps/console", "probe-agent", "packages/notify", "apps/twin"],
     "node_tree": "/opt/cflex/apps/console"},
    {"name": "web", "containerfile": "images/web/Containerfile", "roles": ["app"],
     "base_var": "UBI8_NGINX_122", "packages": []},
]
EXTERNAL = [
    {"name": "redis", "roles": ["app"], "base_var": "RHEL8_REDIS_6"},
    {"name": "postgres", "roles": ["db"], "base_var": "RHEL8_POSTGRESQL_16"},
]
BARE_TREES = {"collector": "collector", "console": "app"}

# better-sqlite3 is a native module: its binary only loads in the Node ABI it was compiled for.
# The images run ubi8/nodejs-20 and the bare profile AppStream nodejs:20 with these same trees,
# so the bundle carries NODE_MODULE_VERSION 115 (Node 20) and nothing else (Node 22 = 127).
NODE_MAJOR = 20
NODE_ABI = "115"
_NODE_CHECK = ("require('better-sqlite3')(':memory:').close();"
               "console.log(process.versions.node + ' ' + process.versions.modules)")


def check_node_abi(runner, podman, ref, tree):
    """Run the image's node in its tree: better-sqlite3 must load and the ABI be NODE_ABI. → {version, abi}."""
    rc, out, err = runner.run([podman, "run", "--rm", "--network=none", "--entrypoint", "node", "-w", tree,
                               ref, "-e", _NODE_CHECK], timeout=300)
    if rc != 0:
        raise RuntimeError("%s: better-sqlite3 does not load in %s: %s" % (ref, tree, (err or out).strip()[-1000:]))
    parts = out.strip().split()
    if len(parts) != 2 or parts[1] != NODE_ABI or parts[0].split(".")[0] != str(NODE_MAJOR):
        raise RuntimeError("%s: node %s (NODE_MODULE_VERSION %s) — the bundle must be Node %d, ABI %s "
                           "(docs/install/CONTAINER_PROFILE.md)" % (ref, parts[0] if parts else "?",
                                                                    parts[1] if len(parts) > 1 else "?",
                                                                    NODE_MAJOR, NODE_ABI))
    return {"version": parts[0], "abi": parts[1]}


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_base_images(path):
    out = {}
    with io.open(path, encoding="utf-8") as f:
        for line in f:
            line = line.split("#")[0].strip()
            if "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


# ── on site ────────────────────────────────────────────────────────────────

class Bundle(object):
    def __init__(self, root):
        self.root = os.path.abspath(root)
        with io.open(os.path.join(self.root, "MANIFEST.json"), encoding="utf-8") as f:
            self.manifest = json.load(f)

    @property
    def version(self):
        return self.manifest["version"]

    def verify(self):
        """Problems with SHA256SUMS (empty list = every file matches and nothing is unlisted)."""
        problems = []
        sums = os.path.join(self.root, "SHA256SUMS")
        if not os.path.exists(sums):
            return ["SHA256SUMS missing"]
        listed = set()
        with io.open(sums, encoding="utf-8") as f:
            for line in f:
                line = line.rstrip("\n")
                if not line:
                    continue
                digest, rel = line.split("  ", 1)
                listed.add(rel)
                p = os.path.join(self.root, rel)
                if os.path.isabs(rel) or ".." in rel.split("/"):
                    problems.append("unsafe path in SHA256SUMS: %s" % rel)
                elif not os.path.exists(p):
                    problems.append("missing: %s" % rel)
                elif sha256_file(p) != digest:
                    problems.append("checksum mismatch: %s" % rel)
        for rel in _walk(self.root):
            if rel not in listed and rel not in ("SHA256SUMS", "SHA256SUMS.asc") and "/__pycache__/" not in "/" + rel:
                problems.append("not in SHA256SUMS: %s" % rel)
        return problems

    def signature_state(self):
        if os.path.exists(os.path.join(self.root, "SHA256SUMS.asc")):
            return "signed"
        return "unsigned — MANIFEST says %s" % self.manifest.get("signature", "nothing")

    def images_for(self, role):
        return [dict(i, path=os.path.join(self.root, i["tar"])) for i in self.manifest["images"] if role in i["roles"]]


def _walk(root):
    out = []
    for d, _, files in os.walk(root):
        for fn in files:
            out.append(os.path.relpath(os.path.join(d, fn), root).replace(os.sep, "/"))
    return sorted(out)


# ── at RingOn ──────────────────────────────────────────────────────────────

def sbom_stub(name, ref, version, ctx, packages, base_ref, base_digest, now):
    comps = []
    for pkg in packages:
        pj = os.path.join(ctx, pkg, "package.json")
        if not os.path.exists(pj):
            continue
        with io.open(pj, encoding="utf-8") as f:
            meta = json.load(f)
        for section in ("dependencies", "optionalDependencies"):
            for dep, rng in sorted((meta.get(section) or {}).items()):
                comps.append({"type": "library", "name": dep, "version": rng,
                              "purl": "pkg:npm/%s@%s" % (dep, rng),
                              "properties": [{"name": "cflex:declared-by", "value": pkg + "/package.json"},
                                             {"name": "cflex:version-is", "value": "declared range, not resolved"}]})
    if base_ref:
        comps.append({"type": "container", "name": base_ref.split("@")[0],
                      "version": base_digest or "unresolved",
                      "properties": [{"name": "cflex:role", "value": "base image"}]})
    return {
        "bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1,
        "serialNumber": "urn:uuid:%s" % uuid.uuid4(),
        "metadata": {
            "timestamp": now,
            "component": {"type": "container", "name": "cflex/" + name, "version": version, "bom-ref": ref},
            "properties": [{"name": "cflex:sbom-status",
                            "value": "STUB — declared npm ranges and base image only. Generate a full SBOM "
                                     "(e.g. syft/cdxgen against the image) before delivery to HAEA Security."}],
        },
        "components": comps,
    }


def build(repo, out_dir, version, runner=None, podman="podman", git="git", git_ref="HEAD",
          build_images=True, gpg_key=None, log=print, now=None):
    """Build cflex-bundle-<version>/ under out_dir. Returns the bundle path."""
    runner = runner or Runner(log=log)
    now = now or datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    root = os.path.join(out_dir, "cflex-bundle-%s" % version)
    if os.path.exists(root):
        raise RuntimeError("%s exists — remove it or pick another version" % root)
    for d in ("images", "app", "sbom", "install", "config", "db/migrations", "docs"):
        os.makedirs(os.path.join(root, d))

    rc, commit, err = runner.run([git, "-C", repo, "rev-parse", git_ref])
    if rc != 0:
        raise RuntimeError("git rev-parse %s: %s" % (git_ref, err.strip()))
    commit = commit.strip()
    rc, dirty, _ = runner.run([git, "-C", repo, "status", "--porcelain", "--untracked-files=no"])

    # Build from `git archive`, not the working tree: untracked or modified files never reach an image.
    ctx = tempfile.mkdtemp(prefix="cflex-ctx-")
    try:
        tarpath = os.path.join(ctx, "src.tar")
        rc, _, err = runner.run([git, "-C", repo, "archive", "--format=tar", "-o", tarpath, commit])
        if rc != 0:
            raise RuntimeError("git archive: %s" % err.strip())
        with tarfile.open(tarpath) as t:
            t.extractall(os.path.join(ctx, "src"))
        src = os.path.join(ctx, "src")
        bases = read_base_images(os.path.join(src, "images", "base-images.env"))

        def resolve(var):
            ref = bases[var]
            if build_images:
                rc, _, err = runner.run([podman, "pull", ref], timeout=1800)
                if rc != 0:
                    raise RuntimeError("podman pull %s: %s" % (ref, err.strip()))
            rc, dg, _ = runner.run([podman, "image", "inspect", "--format", "{{.Digest}}", ref])
            dg = dg.strip() if rc == 0 else ""
            pinned = "%s@%s" % (ref.rsplit(":", 1)[0], dg) if dg.startswith("sha256:") else ref
            return ref, dg or None, pinned

        images = []
        for spec in OWN:
            ref = "localhost/cflex/%s:%s" % (spec["name"], version)
            base_ref, base_dg, pinned = resolve(spec["base_var"])
            if build_images:
                # --format docker: OCI images drop HEALTHCHECK; the Quadlet units carry Health* as well.
                rc, _, err = runner.run([podman, "build", "--format", "docker", "--pull=never",
                                         "-f", os.path.join(src, spec["containerfile"]),
                                         "--build-arg", "BASE_IMAGE=" + pinned,
                                         "--build-arg", "CFLEX_VERSION=" + version,
                                         "--build-arg", "CFLEX_COMMIT=" + commit,
                                         "-t", ref, src], timeout=3600)
                if rc != 0:
                    raise RuntimeError("podman build %s: %s" % (spec["name"], err.strip()[-2000:]))
            # Also with --no-build: whatever is tagged locally is what gets packaged.
            node = check_node_abi(runner, podman, ref, spec["node_tree"]) if spec.get("node_tree") else None
            images.append(dict(spec, ref=ref, base=base_ref, base_digest=base_dg, source="built", node=node))
        for spec in EXTERNAL:
            ref = "localhost/cflex/%s:%s" % (spec["name"], version)
            base_ref, base_dg, pinned = resolve(spec["base_var"])
            rc, _, err = runner.run([podman, "tag", pinned if base_dg else base_ref, ref])
            if rc != 0:
                raise RuntimeError("podman tag %s: %s" % (spec["name"], err.strip()))
            images.append(dict(spec, ref=ref, base=base_ref, base_digest=base_dg, source="redhat (unmodified)", packages=[]))

        manifest_images = []
        for im in images:
            tar_rel = "images/cflex-%s-%s.tar" % (im["name"], version)
            rc, _, err = runner.run([podman, "save", "--format", "docker-archive", "-o", os.path.join(root, tar_rel), im["ref"]], timeout=1800)
            if rc != 0:
                raise RuntimeError("podman save %s: %s" % (im["name"], err.strip()))
            rc, idg, _ = runner.run([podman, "image", "inspect", "--format", "{{.Id}}", im["ref"]])
            sbom_rel = "sbom/cflex-%s-%s.cdx.json" % (im["name"], version)
            with io.open(os.path.join(root, sbom_rel), "w", encoding="utf-8") as f:
                f.write(json.dumps(sbom_stub(im["name"], im["ref"], version, src, im.get("packages", []), im["base"], im["base_digest"], now), indent=2))
                f.write("\n")
            entry = {
                "name": im["name"], "ref": im["ref"], "tar": tar_rel, "sha256": sha256_file(os.path.join(root, tar_rel)),
                "image_id": idg.strip() if rc == 0 else None, "roles": im["roles"], "source": im["source"],
                "base": im["base"], "base_digest": im["base_digest"], "sbom": sbom_rel,
            }
            if im.get("node"):
                entry["node"] = im["node"]
            manifest_images.append(entry)

        # Bare profile: the very same /opt/cflex trees, so both profiles run identical node_modules.
        for tree, img in sorted(BARE_TREES.items()):
            ref = "localhost/cflex/%s:%s" % (img, version)
            cname = "cflex-bundle-extract-%s" % tree
            runner.run([podman, "rm", "-f", cname])
            rc, _, err = runner.run([podman, "create", "--name", cname, ref])
            if rc != 0:
                raise RuntimeError("podman create %s: %s" % (ref, err.strip()))
            rc, _, err = runner.run([podman, "cp", cname + ":/opt/cflex", os.path.join(root, "app", tree)])
            runner.run([podman, "rm", "-f", cname])
            if rc != 0:
                raise RuntimeError("podman cp %s: %s" % (ref, err.strip()))

        # Installer, config examples, docs.
        _copytree(os.path.join(src, "install"), os.path.join(root, "install"), skip=("test", "__pycache__"))
        for fn in ("site.example.yaml", "nmc-targets.example.txt"):
            shutil.copy2(os.path.join(src, "install", fn), os.path.join(root, "config", fn))
        if os.path.isdir(os.path.join(src, "docs", "install")):
            _copytree(os.path.join(src, "docs", "install"), os.path.join(root, "docs"))
        with io.open(os.path.join(root, "db", "migrations", "README.md"), "w", encoding="utf-8") as f:
            f.write(u"No migrations in this bundle. PostgreSQL schema/migrations arrive with WO-INT-008\n"
                    u"as NNN_name.up.sql + NNN_name.down.sql; cflex-install upgrade/rollback runs them.\n")
        with io.open(os.path.join(root, "sbom", "VULN-SCAN.txt"), "w", encoding="utf-8") as f:
            f.write(u"Vulnerability scan: NOT PERFORMED by build-bundle.\n"
                    u"Before delivery, scan every images/*.tar (e.g. `podman image scan`/grype/trivy on the build host)\n"
                    u"and replace this file with the report.\n")
    finally:
        shutil.rmtree(ctx, ignore_errors=True)

    manifest = {
        "product": "cflex-fms-onprem", "version": version, "git_commit": commit,
        "git_tree_dirty": bool(dirty.strip()), "built_at": now,
        "images": manifest_images,
        "bare_trees": {k: "app/" + k for k in sorted(BARE_TREES)},
        "node": {"major": NODE_MAJOR, "abi": NODE_ABI},
        "migrations": [],
        "sbom_status": "stub", "vuln_scan": "not performed",
        "signature": "gpg:%s" % gpg_key if gpg_key else "unsigned",
        "installer": "install/cflex-install",
    }
    with io.open(os.path.join(root, "MANIFEST.json"), "w", encoding="utf-8") as f:
        f.write(json.dumps(manifest, indent=2, sort_keys=True))
        f.write("\n")

    with io.open(os.path.join(root, "SHA256SUMS"), "w", encoding="utf-8") as f:
        for rel in _walk(root):
            if rel in ("SHA256SUMS", "SHA256SUMS.asc"):
                continue
            f.write(u"%s  %s\n" % (sha256_file(os.path.join(root, rel)), rel))
    if gpg_key:
        rc, _, err = runner.run(["gpg", "--batch", "--yes", "--local-user", gpg_key, "--armor", "--detach-sign",
                                 "-o", os.path.join(root, "SHA256SUMS.asc"), os.path.join(root, "SHA256SUMS")])
        if rc != 0:
            raise RuntimeError("gpg sign: %s" % err.strip())
    return root


def _copytree(src, dst, skip=()):
    for d, dirs, files in os.walk(src):
        dirs[:] = [x for x in dirs if x not in skip]
        rel = os.path.relpath(d, src)
        target = os.path.join(dst, rel) if rel != "." else dst
        if not os.path.isdir(target):
            os.makedirs(target)
        for fn in files:
            if fn.endswith(".pyc"):
                continue
            shutil.copy2(os.path.join(d, fn), os.path.join(target, fn))
