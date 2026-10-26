#!/bin/bash
# install.sh — cflex-probe (Collector) on RHEL 8.10 / RHEL 9, bare profile (spec 01 §3.2).
#
# RHEL only. No apt, no NodeSource, no git clone, no internet: Node.js 20 comes from
# the HAEA Satellite AppStream (`dnf module enable nodejs:20`), the code from the
# offline bundle. The container profile (default) does not use this script at all.
#
# This is a thin front for the common installer, so the two profiles cannot drift:
#   sudo ./install.sh --config /opt/app/cflex/config/site.yaml            # print the plan
#   sudo ./install.sh --config /opt/app/cflex/config/site.yaml --yes      # apply it
# Any other cflex-install option is passed through (--host-id, --bundle, --dry-run).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "install.sh: run with sudo" >&2; exit 2; fi

. /etc/os-release 2>/dev/null || true
case "${ID:-}:${VERSION_ID:-}" in
  rhel:8.10|rhel:9.*) ;;
  rhel:*|rocky:8*|rocky:9*|almalinux:8*|almalinux:9*)
    echo "install.sh: ${PRETTY_NAME:-$ID $VERSION_ID} — target is RHEL 8.10 (RHEL 9 compatible); continuing" >&2 ;;
  *) echo "install.sh: RHEL 8.10 / 9.x only (found ${PRETTY_NAME:-unknown})" >&2; exit 2 ;;
esac

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Repository: probe-agent/../install. Bundle: app/collector/probe-agent/../../../install.
for c in "$here/../install/cflex-install" "$here/../../../install/cflex-install"; do
  if [ -x "$c" ]; then
    # install runs preflight first and stops on any FAIL; without --yes it only prints the plan.
    exec "$c" install --role collector --profile bare "$@"
  fi
done
echo "install.sh: cflex-install not found (expected ../install/cflex-install or the bundle's install/)" >&2
exit 2
