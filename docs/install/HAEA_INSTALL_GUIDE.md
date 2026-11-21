# C-Flex FMS 2.0 On-Prem — HAEA Installation Guide and SAT Checklist

Bundle: `cflex-bundle-2.0.0-rc.2` (release candidate). The bundle's SHA-256 is sent separately with the
transmittal, never inside the bundle. Verify it before copying the bundle anywhere.

Everything in this guide was rehearsed end to end on a mirror of the HAEA environment (Azure, 4 × RHEL 8.10,
SELinux Enforcing, firewalld, no internet, proxy-only egress, 41 simulated APC NMCs). The lab results are in
the SAT table (§6); the HAEA column is for the on-site run.

Detailed references, all in `docs/` of the bundle:
`CONTAINER_PROFILE.md` (container profile, ports, upgrade), `PG_BACKUP_RESTORE.md` (backup, restore, PITR),
`REDIS_FAILOVER.md` (app01 failure → app02).

---

## 1. What HAEA provides before the install window

| # | Item | Used for | Where it goes |
|---|---|---|---|
| H1 | 4 VMs: cap01 10.138.14.66, app01 .67, app02 .68, db01 .69, RHEL 8.10, SELinux Enforcing | — | — |
| H2 | `container-tools:rhel8` module installed from Satellite on all 4 (Podman 4.9) | runtime | — |
| H3 | Free space: `/home` ≥ 10 GB and `/opt` ≥ 10 GB on every VM; db01 `/opt/data` 500 GB | images (rootless, under `/home/cflex`), bundle, data | — |
| H4 | Firewall request v3 approved (FW-1 … FW-8) | network | — |
| H5 | HTTP proxy `host:port` (and credentials, if any) for app01/app02 → cflex.fms.support:443 | Portal link (FW-4) | `site.yaml portal.proxy` |
| H6 | SMTP relay host and port | local e-mail (FW-8) | `site.yaml notify.smtp` |
| H7 | User VLAN/VPN ranges (console users) | FW-5 | `site.yaml install.user_sources` |
| H8 | RingOn maintenance ranges (VPN/jump) | FW-6 | `site.yaml install.maintenance_sources` |
| H9 | Console TLS certificate from the HAEA internal CA for app01 and app02 (SAN = IP and/or DNS name users type), plus the CA chain | Local Console HTTPS | `/opt/app/cflex/certs/console.crt`, `console.key` (app01, app02); `console-ca.pem` (app01, app02, cap01) |
| H10 | SNMPv3 user, auth/priv protocols and keys for the NMCs (per site) | polling | entered once in the console (Settings → Credentials), never in a file |

Not needed on the probe: ServiceNow and Teams (D-17: the Portal does ticketing and messaging).

## 2. `site.yaml` — the only file to edit

Copy `config/site.example.yaml` to `/opt/app/cflex/config/site.yaml` (same file on all 4 VMs). Replace exactly these:

| Key | Example value | From |
|---|---|---|
| `portal.proxy` | `"http://<haea-proxy>:<port>"` | H5 |
| `notify.smtp.host` / `port` | `<relay>` / `587` | H6 |
| `install.user_sources` | `[10.x.x.0/24, …]` | H7 |
| `install.maintenance_sources` | `[…]` | H8 |

Nothing else changes for HAEA. No secret goes into `site.yaml`. Also copy `config/nmc-targets.example.txt` (the 41 NMC IPs)
to `/opt/app/cflex/config/nmc-targets.txt`.

## 3. Install (MOP)

Run from the RingOn jump host. `ssh <node>` below means an SSH session to that VM as an admin with sudo.
Commands inside a node run from the unpacked bundle directory (`cd ~/cflex-bundle-2.0.0-rc.2`).
`install/cflex-as` runs one command as the `cflex` service user (it has no login shell, so `sudo -iu cflex` does not work).

**Step 0 — bundle and config on all 4 VMs**
```
sha256sum cflex-bundle-2.0.0-rc.2.tar        # compare with the transmittal
# copy the tar to each VM, then on each VM:
tar -xf cflex-bundle-2.0.0-rc.2.tar && cd cflex-bundle-2.0.0-rc.2 && sha256sum -c --quiet SHA256SUMS
sudo install -d -m 750 /opt/app/cflex/config
sudo cp <edited>/site.yaml /opt/app/cflex/config/site.yaml
sudo cp config/nmc-targets.example.txt /opt/app/cflex/config/nmc-targets.txt
sudo install/cflex-install preflight --role <db|app|collector>      # must end PASS
```
Console certificate (H9) on app01 and app02 before Step 2; `console-ca.pem` also on cap01:
```
sudo install -d -m 755 /opt/app/cflex/certs
sudo install -m 644 console.crt console-ca.pem /opt/app/cflex/certs/ && sudo install -m 600 console.key /opt/app/cflex/certs/
```

**Step 1 — db01**
```
sudo install/cflex-install install --role db            # prints the plan, changes nothing
sudo install/cflex-install install --role db --yes
sudo install/cflex-as systemctl --user start cflex-pg-backup     # first base backup
```
Copy the database password to both app nodes **through a pipe** (never a file on the jump host, never e-mail/chat):
```
ssh db01 'sudo cat /opt/app/cflex/secrets/db/pg.pass' | ssh app01 'sudo install -d -m 700 /opt/app/cflex/secrets/app && sudo sh -c "cat > /opt/app/cflex/secrets/app/pg.pass && chmod 600 /opt/app/cflex/secrets/app/pg.pass"'
# same again with app02
```

**Step 2 — app01 (active), then copy its Redis password and console key to app02**
```
sudo install/cflex-install install --role app --yes
ssh app01 'sudo cat /opt/app/cflex/secrets/app/redis.pass'  | ssh app02 'sudo sh -c "cat > /opt/app/cflex/secrets/app/redis.pass  && chmod 600 /opt/app/cflex/secrets/app/redis.pass"'
ssh app01 'sudo cat /opt/app/cflex/secrets/app/console.key' | ssh app02 'sudo sh -c "cat > /opt/app/cflex/secrets/app/console.key && chmod 600 /opt/app/cflex/secrets/app/console.key"'
```

**Step 3 — app02 (standby)**
```
sudo install/cflex-install install --role app --yes
```

**Step 4 — cap01: the console issues the collector key (printed once), piped straight to cap01**
```
ssh app01 'cd ~/cflex-bundle-2.0.0-rc.2 && sudo install/cflex-as podman exec cflex-console node /opt/cflex/apps/console/src/cli.js collector-key cap01' \
  | tr -d '\r\n' | ssh cap01 'sudo install -d -m 700 /opt/app/cflex/secrets/collector && sudo sh -c "cat > /opt/app/cflex/secrets/collector/collector.key && chmod 600 /opt/app/cflex/secrets/collector/collector.key"'
sudo install/cflex-install install --role collector --yes          # on cap01
```

**Step 5 — Portal device certificates (app01, app02).** The key is made on the node and never leaves it (contract §6):
```
sudo openssl genrsa -out /opt/app/cflex/certs/device.key 2048 && sudo chown cflex:cflex /opt/app/cflex/certs/device.key && sudo chmod 600 /opt/app/cflex/certs/device.key
sudo openssl req -new -key /opt/app/cflex/certs/device.key -subj /CN=HAEA.app01      # HAEA.app02 on app02 → send the CSR to RingOn
# RingOn returns device.pem and portal-ca.pem:
sudo install -o cflex -g cflex -m 644 device.pem portal-ca.pem /opt/app/cflex/certs/
sudo install/cflex-as systemctl --user restart cflex-console
```
Until the certificate is in place (or while the Portal is unreachable) the FMS keeps everything in its 7-day outbox
(`portal.buffer_days`) and sends it in order, once, when the link works (SAT 5).

**Step 6 — verify all four**
```
sudo install/cflex-install verify   --role <role>     # each VM: 결과: PASS — FAIL 0
sudo install/cflex-install netcheck --role <role>     # each VM: FAIL 0 (WARN lines = RHEL services, recorded)
```

**Step 7 — first use (console)**
```
printf '%s\n' '<initial password>' | sudo install/cflex-as podman exec -i cflex-console node /opt/cflex/apps/console/src/cli.js create-user <name> admin   # app01
```
Then in the browser (`https://<app01>/fms/`): change the password at first login → Settings → Sites (HMA-FV, KUS-IRV, HAEA-HQ) →
Credentials (SNMPv3 per site, H10) → Import `config/haea-inventory.example.csv` (41 NMCs; dry run first).
The collector picks the inventory up within 5 minutes.

## 4. Upgrade and rollback

```
sudo install/cflex-install upgrade --role app --bundle ~/cflex-bundle-<new> --yes                  # app02 first
sudo install/cflex-install verify  --role app
sudo install/cflex-install upgrade --role app --bundle ~/cflex-bundle-<new> --yes --standby-done   # then app01
sudo install/cflex-install upgrade --role collector --bundle ~/cflex-bundle-<new> --yes            # cap01
sudo install/cflex-install upgrade --role db --bundle ~/cflex-bundle-<new> --yes                   # db01
sudo install/cflex-install rollback --role <role> --yes                                            # any node, no bundle needed
```
The active app node refuses to upgrade without `--standby-done`. A failed upgrade rolls itself back (exit 3).

## 5. Backup and restore

Daily base backup at 02:30 + continuous WAL archive, 14 days, `/opt/data/backup` (db01). Restore — apps stopped first:
```
sudo install/cflex-as systemctl --user stop cflex-console                                           # app01, app02
sudo install/cflex-pg-recover --set /opt/data/backup/base-YYYYMMDD --immediate --yes               # to the end of that backup
sudo install/cflex-pg-recover --set /opt/data/backup/base-YYYYMMDD --time 'YYYY-MM-DD HH:MM:SS+00' --yes   # to a point in time
sudo install/cflex-as systemctl --user start cflex-console                                          # app01, app02
```
Then one base backup on the new timeline (`PG_BACKUP_RESTORE.md` §4). Do not restore by hand: the Red Hat image's own
start script cannot finish a recovery (it runs `ALTER USER` while the server is read-only and restarts forever).

## 6. SAT checklist

Spec 01 §5. "Lab" = HAEA mirror, 2026-11-21, bundles 2.0.0-lab.2 → lab.4 → rc.1 (rc.2 = rc.1 + installer report fix + documents).

| SAT | Item | Procedure / evidence | Pass criterion | Lab | HAEA |
|---|---|---|---|---|---|
| 1 | Install | §3 on 4 VMs; `verify` + `netcheck` output; install logs `/opt/app/cflex/log/` | verify FAIL 0 on 4; netcheck FAIL 0; no network call during install | PASS — clean install, 0 manual steps; netcheck FAIL 0 on 4 (82 false listeners fixed, note 3). No-network-call evidence (proxy log during install) not collected in lab — collect at HAEA | |
| 2 | 44 UPS displayed and collected, SNMPv3 | console Devices; collector log `cycle: N ok, 0 fail` | all units online in the console | PASS for 41 simulated (v2c in lab; v3 is the HAEA run) | |
| 3 | Trap | NMC self-test or `snmptrap` to cap01:162 | event in the console | not run in lab (trap path covered by tests, WO-INT-006) | |
| 4 | P1 On Battery | put one UPS on battery | P1 alarm in console; local e-mail; Portal receives the event | PASS — P1 "Output source: onBattery"; Portal mock received events. ServiceNow test ticket: on hold (D-17) | |
| 5 | Portal link cut → no loss | block cflex.fms.support at the proxy ≥ 10 min, restart the sending app node meanwhile, restore | outbox drains; every point once | PASS — 10 min cut, app02 restarted mid-cut, drained in 64 s, 369/369 points, 0 duplicates | |
| 6 | app01 down → app02 | stop app01 VM; `REDIS_FAILOVER.md` §2 | collection continues; console on app02 after `promote` | PASS — collector switched to app02, polling continued | |
| 7a | Backup / restore | `PG_BACKUP_RESTORE.md` §6 B1–B11 | all PASS | PASS — B1–B11 (PITR marker restored; base restore counts match; archive 0 failed) | |
| 7b | Upgrade / rollback | §4 | verify PASS after each; data kept | PASS — lab.2→lab.4→rc.1, rollback rc.1→lab.4 (≈5 s/node), re-upgrade; 41 devices/2 users/3 open alarms kept | |
| 7c | Reboot → auto start | reboot all 4 at once | all services healthy without action | PASS — all healthy; collection resumed 1 m 47 s after reboot | |
| 7d | Image trust | `podman image trust` / MANIFEST digests | digests match | partial — `SHA256SUMS` checked on every node and re-checked by the installer before `podman load`; `podman image trust` and GPG signature not done for the rc (§7) | |
| 8a | SELinux | `verify`: selinux, selinux denials (since boot) | Enforcing, 0 denials | PASS — 0 after the `:z` fix (note 1) | |
| 8b | No plaintext secrets | `verify`: secrets in logs; file modes | 0; secrets 0600 cflex | PASS — 0 on 4 nodes after the log fix (note 2) | |
| 8c | EDR | HAEA EDR console shows the container processes normally | normal | HAEA only | |

Notes — defects the lab found and this bundle fixes:
1. Shared certificate directory mounted with a private SELinux label by two containers → after a restart nginx could no longer
   read its certificate (`:Z` → `:z`).
2. The database password could reach the PostgreSQL log in plain text when the image's `ALTER USER` failed (read-only
   server) → `log_min_error_statement = panic`; `verify` now scans the journal and logs for every secret (reading the
   value from the file, never from a command line).
3. Portal traffic did not go through the proxy (Node HTTPS agent option) — every Portal send would have timed out at HAEA.
   `netcheck` listed rootless Podman's outbound UDP polling sockets as unknown listeners (82 on cap01).
4. Restore by hand could not complete (see §5) → `install/cflex-pg-recover`. A collector booting before the app nodes
   waited 5 minutes for its inventory → retries every 30 s.

## 7. Open items (not blockers for install)

- **Portal API not live yet** (cflex.fms.support `/api/v1` + mTLS, RingOn side). The FMS buffers 7 days; data older than
  that is purged from the outbox (it stays in the local database).
- SBOM files are stubs and the vulnerability scan was not run (`sbom/VULN-SCAN.txt`) — to be replaced before HAEA Security review.
- Bundle not GPG-signed (rc). The final release is signed (`SHA256SUMS.asc`).
- Quantity: SOW 44 units; 41 have NMC IPs in Exhibit 1 (firewall, inventory file); 3 HMA units without IP are added on site.
