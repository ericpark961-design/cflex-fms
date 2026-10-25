"""cflex-install CLI.

  cflex-install preflight --role app --profile container --config site.yaml
  cflex-install install   --role app --profile container --config site.yaml [--yes]
  cflex-install verify    --role app --config site.yaml [--send-test]
  cflex-install netcheck  --role app --config site.yaml [--format text|json]
  cflex-install upgrade   --role app --config site.yaml --bundle /path/cflex-bundle-<v> [--yes] [--standby-done]
  cflex-install rollback  --role app --config site.yaml [--yes]
  cflex-install render    --role app --host-id app01 --config site.yaml --out DIR [--podman 4.9] [--ports forward]

Exit: 0 ok · 1 check failed · 2 refused (no --yes, bad arguments) · 3 install/upgrade failed.
"""

import argparse
import io
import json
import os
import sys
import time

from . import __version__, bundle as bundle_mod, deploy, netcheck, preflight, render, siteconf, verify
from .sysrun import Runner

LOG_DIR = render.BASE + "/log"
HERE = os.path.dirname(os.path.abspath(__file__))
INSTALL_DIR = os.path.normpath(os.path.join(HERE, "..", ".."))


def _logger(cmd, enabled):
    path = None
    fh = None
    if enabled and os.geteuid() == 0:
        try:
            # One level at a time with its own mode: os.makedirs(LOG_DIR, 0o750) would also make
            # /opt/app and /opt/app/cflex root-only, and rootless Podman (user cflex) could not reach
            # any volume below them.
            for d, mode in ((os.path.dirname(render.BASE), 0o755), (render.BASE, 0o755), (LOG_DIR, 0o750)):
                if not os.path.isdir(d):
                    os.mkdir(d, mode)
                    os.chmod(d, mode)
            path = os.path.join(LOG_DIR, "install-%s-%s.log" % (time.strftime("%Y%m%dT%H%M%S"), cmd))
            fh = io.open(path, "a", encoding="utf-8")
        except OSError:
            fh = None

    def log(msg, echo=True):
        if echo:
            print(msg)
            sys.stdout.flush()
        if fh:
            fh.write(u"%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg))
            fh.flush()
    log.path = path
    return log


def _default_bundle():
    root = os.path.dirname(INSTALL_DIR)
    return root if os.path.exists(os.path.join(root, "MANIFEST.json")) else None


def main(argv=None):
    ap = argparse.ArgumentParser(prog="cflex-install", description="C-Flex on-prem installer (spec 01 §3.3)")
    ap.add_argument("command", choices=["preflight", "install", "verify", "netcheck", "upgrade", "rollback", "render", "version"])
    ap.add_argument("--role", choices=siteconf.ROLES)
    ap.add_argument("--profile", choices=["container", "bare"], default=None,
                    help="default: what is deployed here, else container")
    ap.add_argument("--config", default=render.CONFIG + "/site.yaml")
    ap.add_argument("--host-id", help="this host's id in site.yaml (default: matched by IP)")
    ap.add_argument("--bundle", default=None, help="bundle directory (default: the one this installer came in)")
    ap.add_argument("--yes", action="store_true", help="apply the plan (without it, only print it)")
    ap.add_argument("--dry-run", action="store_true", help="with --yes: log mutating commands instead of running them")
    ap.add_argument("--format", choices=["text", "json"], default="text")
    ap.add_argument("--send-test", action="store_true", help="verify: send a real ServiceNow test ticket")
    ap.add_argument("--standby-done", action="store_true", help="upgrade on the active app node after the standby")
    ap.add_argument("--self-signed-console-cert", action="store_true", help="install: staging only, 90-day cert")
    ap.add_argument("--no-resolve", action="store_true", help="netcheck: do not resolve names from site.yaml")
    ap.add_argument("--out", help="render: write files under this directory instead of the host")
    ap.add_argument("--podman", default=None, help="render: assume this Podman version (default 4.9)")
    ap.add_argument("--ports", choices=["forward", "sysctl"], default=None, help="render: privileged-port mode")
    ap.add_argument("--version-tag", default="0.0.0-dev", help="render: image tag")
    a = ap.parse_args(argv)

    if a.command == "version":
        print("cflex-install %s" % __version__)
        return 0
    if not a.role:
        ap.error("--role is required")

    log = _logger(a.command, a.command in ("preflight", "install", "upgrade", "rollback", "verify", "netcheck"))
    runner = Runner(log=lambda m: log(m, echo=False), dry_run=a.dry_run)

    try:
        site = siteconf.load(a.config)
    except (IOError, OSError, siteconf.ConfigError) as e:
        print("site.yaml: %s" % e, file=sys.stderr)
        return 2
    errs = siteconf.validate(site)

    state = deploy.read_state(runner)
    profile = a.profile or state.get("profile") or "container"

    if a.command == "render":
        if errs:
            print("site.yaml: " + "; ".join(errs), file=sys.stderr)
            return 2
        try:
            me = siteconf.find_host(site, a.role, a.host_id, ())
            files = render.render(site, a.role, me, a.version_tag, profile=profile, podman_version=a.podman or "4.9",
                                  ports_mode=a.ports or "forward", home="/home/cflex")
        except (siteconf.ConfigError, render.RenderError) as e:
            print("render: %s (render needs --host-id)" % e, file=sys.stderr)
            return 2
        for path in sorted(files):
            content, mode = files[path]
            target = os.path.join(a.out, path.lstrip("/")) if a.out else None
            if target:
                if not os.path.isdir(os.path.dirname(target)):
                    os.makedirs(os.path.dirname(target))
                with io.open(target, "w", encoding="utf-8") as f:
                    f.write(content)
                os.chmod(target, mode)
            print("%o %s" % (mode, path))
        return 0

    bundle = None
    bpath = a.bundle or _default_bundle()
    if bpath and a.command in ("preflight", "install", "upgrade"):
        try:
            bundle = bundle_mod.Bundle(bpath)
        except (IOError, OSError, ValueError) as e:
            log("bundle %s: %s" % (bpath, e))
            return 2

    if a.command == "preflight":
        checks, me, facts = preflight.run(site, a.role, profile, runner, a.host_id, bundle)
        if a.format == "json":
            print(json.dumps({"checks": [c.as_dict() for c in checks], "facts": facts}, indent=2, ensure_ascii=False))
        else:
            log(preflight.format_text(checks, a.role, profile, me))
            if bundle and me:
                c = _ctx(site, a, me, profile, runner, bundle, facts, log)
                log(deploy.describe(c, deploy.plan_install(c)))
        return 1 if any(c.verdict == "FAIL" for c in checks) else 0

    if errs:
        log("site.yaml: " + "; ".join(errs))
        return 2
    try:
        me = siteconf.find_host(site, a.role, a.host_id, preflight.local_ips(runner))
    except siteconf.ConfigError as e:
        log(str(e))
        return 2

    if a.command == "netcheck":
        fwd = state.get("ports_mode") == "forward" or (profile == "container" and preflight.choose_ports_mode(site, runner)[0] == "forward")
        lis, est = netcheck.collect(runner)
        rules = netcheck.forward_rules(runner, siteconf.get(site, "install.firewall_zone", "public")) if fwd else set()
        rep = netcheck.evaluate(netcheck.load_matrix(), site, a.role, me, lis, est, runner, forward_mode=fwd,
                                forward_rules=rules, resolve=None if a.no_resolve else netcheck.default_resolver,
                                installed=bool(state.get("version")))
        if a.format == "json":
            print(json.dumps(rep, indent=2, ensure_ascii=False))
        else:
            log(netcheck.format_text(rep))
        return 0 if rep["ok"] else 1

    if a.command == "verify":
        c = _ctx(site, a, me, profile, runner, None, {"podman": None, "ports_mode": state.get("ports_mode")}, log)
        res = verify.run(site, a.role, me, profile, runner, as_cflex=c.as_cflex, send_test=a.send_test)
        log(verify.format_text(res, a.role, me))
        return 1 if any(r.verdict == "FAIL" for r in res) else 0

    # install / upgrade / rollback
    if a.command in ("install", "upgrade") and not bundle:
        log("--bundle is required (no MANIFEST.json next to this installer)")
        return 2
    checks, _, facts = preflight.run(site, a.role, profile, runner, a.host_id, bundle)
    if a.command != "install" and state.get("ports_mode"):
        facts["ports_mode"] = state["ports_mode"]  # upgrade/rollback keep what install chose
    c = _ctx(site, a, me, profile, runner, bundle, facts, log)
    if a.command == "install":
        fails = [x for x in checks if x.verdict == "FAIL"]
        log(preflight.format_text(checks, a.role, profile, me))
        log(deploy.describe(c, deploy.plan_install(c)))
        if fails:
            log("preflight FAIL — not installing")
            return 1
    else:
        log("%s: role=%s profile=%s host=%s current=%s previous=%s%s" % (
            a.command, a.role, profile, me[1], state.get("version"), state.get("previous"),
            (" → %s" % bundle.version) if bundle else ""))
    if not a.yes:
        log("nothing changed — re-run with --yes to apply")
        return 2
    try:
        if a.command == "install":
            msg = deploy.install(c)
            st = deploy.read_state(runner)
            st["ports_mode"] = c.ports_mode
            deploy.write_state(c, st)
        elif a.command == "upgrade":
            msg = deploy.upgrade(c, standby_done=a.standby_done)
        else:
            msg = deploy.rollback(c)
    except deploy.DeployError as e:
        log("FAILED: %s" % e)
        return 3
    log("OK: %s" % msg)
    if log.path:
        log("log: %s" % log.path)
    return 0


def _ctx(site, a, me, profile, runner, bundle, facts, log):
    return deploy.Ctx(site, a.role, me, profile, runner, bundle=bundle,
                      podman_version=facts.get("podman") or "4.9",
                      ports_mode=facts.get("ports_mode") or "forward", log=log,
                      self_signed=getattr(a, "self_signed_console_cert", False))


if __name__ == "__main__":
    sys.exit(main())
