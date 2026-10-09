#!/usr/bin/env bash
# Build apps/twin and publish it to VM1 as https://fms.runless.co.uk/twin/
#
#   ./deploy/deploy-twin.sh [ssh-host]      default host: vm1 (172.172.161.236)
#
# Rollback: delete /opt/cflex-fms/twin-dist on VM1 and drop the `location /twin/`
# blocks from the vhost. Nothing else on fms.runless.co.uk depends on either.
set -euo pipefail

HOST=${1:-vm1}
REMOTE_DIR=/opt/cflex-fms/twin-dist
APP_DIR="$(cd "$(dirname "$0")/../apps/twin" && pwd)"

echo "==> building $APP_DIR"
cd "$APP_DIR"
npm ci
npm run build

echo "==> publishing to $HOST:$REMOTE_DIR"
ssh "$HOST" "sudo mkdir -p $REMOTE_DIR && sudo chown \$USER $REMOTE_DIR"
rsync -az --delete dist/ "$HOST:$REMOTE_DIR/"

# The vhost must carry the `location ^~ /twin/` blocks (nginx/vm1-fms-vhost.conf).
# Without the ^~ the existing `~* \.(html|json)$` regex location wins and every
# /twin/ path 404s, so fail loudly here rather than after a silent reload.
echo "==> checking nginx vhost"
# -R, not -r: sites-enabled holds symlinks, which -r skips during recursion.
if ! ssh "$HOST" "grep -Rq 'location ^~ /twin/' /etc/nginx/sites-enabled/ 2>/dev/null"; then
  echo "ERROR: no 'location ^~ /twin/' block found in /etc/nginx/sites-enabled/ on $HOST." >&2
  echo "       Copy nginx/vm1-fms-vhost.conf from this repo to the server first." >&2
  exit 1
fi

echo "==> reloading nginx"
ssh "$HOST" 'sudo nginx -t && sudo systemctl reload nginx'

echo
echo "deployed: https://fms.runless.co.uk/twin/"
