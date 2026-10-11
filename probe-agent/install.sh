#!/bin/bash
# install.sh — install cflex-probe on Ubuntu 22.04 VM
# Usage: sudo bash install.sh
set -e

if [ "$EUID" -ne 0 ]; then echo "Run as root (sudo)"; exit 1; fi

REPO_URL="${REPO_URL:-https://github.com/ericpark961-design/cflex-probe.git}"
INSTALL_DIR=/opt/cflex-probe
SERVICE_USER=cflex

echo "[install] cflex-probe installer — Ubuntu 22.04"

# ── 1. Dependencies
apt-get update
apt-get install -y curl git build-essential ca-certificates

# Node.js 20 LTS via NodeSource
if ! command -v node >/dev/null || [ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "[install] node: $(node -v)"

# ── 2. Create service user
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --shell /usr/sbin/nologin --home "$INSTALL_DIR" "$SERVICE_USER"
fi

# ── 3. Pull / refresh code
if [ ! -d "$INSTALL_DIR/.git" ]; then
  git clone "$REPO_URL" "$INSTALL_DIR"
else
  git -C "$INSTALL_DIR" pull --ff-only
fi

# ── 4. Install npm deps
cd "$INSTALL_DIR"
sudo -u "$SERVICE_USER" npm install --omit=dev

# ── 5. Bootstrap .env if not present
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  chmod 640 "$INSTALL_DIR/.env"
  chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/.env"
  echo "[install] .env created. EDIT IT: $INSTALL_DIR/.env"
  echo "[install]   Set CFLEX_TOKEN and TENANT_ID before starting."
fi

# ── 6. Data dir
mkdir -p "$INSTALL_DIR/data"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# ── 7. Log files
touch /var/log/cflex-probe.log /var/log/cflex-probe.err
chown "$SERVICE_USER:$SERVICE_USER" /var/log/cflex-probe.*

# ── 8. systemd
cp "$INSTALL_DIR/systemd/cflex-probe.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable cflex-probe

echo
echo "==============================================="
echo " cflex-probe installed at $INSTALL_DIR"
echo " Edit:   $INSTALL_DIR/.env"
echo " Start:  systemctl start cflex-probe"
echo " Logs:   journalctl -u cflex-probe -f"
echo "         tail -f /var/log/cflex-probe.log"
echo "==============================================="
