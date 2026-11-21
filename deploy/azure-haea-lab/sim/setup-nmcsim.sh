#!/bin/bash
# Run on nmcsim (root). Puts the 41 NMC IPs on a dummy interface and runs ups-fleet as a service.
set -euo pipefail
D=/opt/lab-sim
ip link show nmc0 >/dev/null 2>&1 || ip link add nmc0 type dummy
ip link set nmc0 up
tail -n +2 $D/fleet.csv | cut -d, -f4 | while read -r ip; do ip addr show dev nmc0 | grep -q " $ip/" || ip addr add "$ip/32" dev nmc0; done
[ "${1:-}" = "--ips-only" ] && exit 0
cat > /etc/systemd/system/ups-fleet.service <<UNIT
[Unit]
Description=HAEA lab UPS fleet simulator (41 NMC IPs)
After=network-online.target
[Service]
ExecStartPre=/bin/bash $D/setup-nmcsim.sh --ips-only
ExecStart=/usr/bin/node $D/ups-fleet.js $D/fleet.csv
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now ups-fleet
