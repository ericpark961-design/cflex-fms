#!/usr/bin/env bash
# HAEA mirror lab — put a Portal stand-in behind "cflex.fms.support" for SAT 5 (WO-INT-015).
#
#   nmcsim  : lab CA + server cert (CN cflex.fms.support), sim/portal-mock.js on :443 (systemd lab-portal)
#   svc     : /etc/hosts cflex.fms.support -> nmcsim, so the squid proxy (FW-4 path) reaches the mock
#   app01/02: device key + CSR made ON the node (contract 6: the key never leaves it), CSR signed by the
#             lab CA, device.pem + portal-ca.pem placed, cflex-console restarted
#
# HAEA: the real device certificate comes from the Portal's CA; none of this ships.  Run from the Mac:
#   sim/setup-portal-mock.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; cd "$HERE"
S=.state/ssh_config; REPO="$(cd ../.. && pwd)"; NODE=/opt/node-v20.18.1-linux-x64/bin/node
q() { grep -vE 'post-quantum|store now|upgraded|Permanently added' || true; }

echo "== nmcsim: mock + lab CA"
tar -C "$REPO" -czf - probe-agent/test/support/mock-portal.js probe-agent/src/contract/schema.js docs/spec/schemas \
  -C "$HERE/sim" portal-mock.js \
  | ssh -F $S nmcsim 'sudo install -d -m 755 /opt/lab-portal && sudo tar -xzf - -C /opt/lab-portal' 2>&1 | q
ssh -F $S nmcsim "sudo NODE=$NODE bash -s" 2>&1 <<'NMC' | q
set -e; D=/opt/lab-portal/ca; install -d -m 700 $D; cd $D
if [ ! -f ca.pem ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 120 -subj "/CN=cflex-haea-lab-portal-ca" -keyout ca.key -out ca.pem 2>/dev/null
  printf 'subjectAltName=DNS:cflex.fms.support\nextendedKeyUsage=serverAuth\n' > server.ext
  printf 'extendedKeyUsage=clientAuth\n' > client.ext
  openssl req -newkey rsa:2048 -nodes -subj "/CN=cflex.fms.support" -keyout server.key -out server.csr 2>/dev/null
  openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 120 -extfile server.ext -out server.pem 2>/dev/null
fi
printf '%s\n' '[Unit]' 'Description=C-Flex Portal stand-in (lab, SAT 5)' 'After=network-online.target' \
  '[Service]' 'WorkingDirectory=/opt/lab-portal' 'Environment=CFLEX_SCHEMA_DIR=/opt/lab-portal/docs/spec/schemas' \
  "ExecStart=$NODE /opt/lab-portal/portal-mock.js" 'Restart=always' '[Install]' 'WantedBy=multi-user.target' \
  > /etc/systemd/system/lab-portal.service
systemctl daemon-reload; systemctl enable -q lab-portal; systemctl restart lab-portal
sleep 1; echo "lab-portal $(systemctl is-active lab-portal)"
NMC

echo "== svc: cflex.fms.support -> nmcsim (proxy path)"
ssh -F $S svc 'grep -q "cflex.fms.support" /etc/hosts || echo "10.138.16.20 cflex.fms.support  # LAB portal mock" | sudo tee -a /etc/hosts >/dev/null
  sudo systemctl restart squid && echo "squid restarted"' 2>&1 | q

C=/opt/app/cflex/certs
for n in app01 app02; do
  echo "== $n: device certificate (CN HAEA.$n)"
  ssh -F $S $n "sudo test -f $C/device.key || sudo openssl genrsa -out $C/device.key 2048 2>/dev/null
    sudo chown cflex:cflex $C/device.key && sudo chmod 600 $C/device.key
    sudo openssl req -new -key $C/device.key -subj /CN=HAEA.$n" 2>/dev/null \
  | ssh -F $S nmcsim "sudo sh -c 'cd /opt/lab-portal/ca && openssl x509 -req -CA ca.pem -CAkey ca.key -CAcreateserial -days 120 -extfile client.ext 2>/dev/null'" \
  | ssh -F $S $n "sudo sh -c 'cat > $C/device.pem' && sudo chown cflex:cflex $C/device.pem && sudo chmod 644 $C/device.pem && echo '$n: device.pem placed'" 2>&1 | q
  ssh -F $S nmcsim 'sudo cat /opt/lab-portal/ca/ca.pem' 2>/dev/null \
  | ssh -F $S $n "sudo sh -c 'cat > $C/portal-ca.pem' && sudo chmod 644 $C/portal-ca.pem
    U=\$(id -u cflex); sudo runuser -u cflex -- env --chdir=/home/cflex XDG_RUNTIME_DIR=/run/user/\$U systemctl --user restart cflex-console && echo '$n: cflex-console restarted'" 2>&1 | q
done
echo "stats: ssh -F $S nmcsim curl -s 127.0.0.1:9180/stats"
