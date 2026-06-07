# cflex-fms push + ack deploy bundle

Drop-in install of Expo push notifications + alert ack for a running
`cflex-v2` deployment. Bundles the new files, an idempotent installer,
a rollback, a test harness, and an end-to-end walkthrough.

## Contents

```
deploy/
├── backend/
│   ├── migrations/
│   │   ├── 002_fms_push_subscriptions.sql
│   │   └── 003_alerts_ack.sql
│   ├── routes/
│   │   ├── fms-push.routes.js
│   │   └── fms-ack.routes.js
│   └── services/
│       └── expo-push-notifier.js
├── deploy-push-ack.sh        — idempotent installer (interactive)
├── rollback-push-ack.sh      — restore from backup
├── test-push-ack.sh          — post-install sanity checks
└── E2E_TEST.md               — phone + VM walkthrough
```

## Quick start (on the cflex-v2 VM)

```bash
# 1. Copy this directory to the VM
scp -r deploy/ user@cflex-vm:/tmp/push-ack-deploy/

# 2. SSH in and run (interactive — asks before each edit)
ssh user@cflex-vm
cd /tmp/push-ack-deploy
./deploy-push-ack.sh           # add --dry-run first to preview
./deploy-push-ack.sh --yes     # CI/scripted, no prompts

# 3. Verify
./test-push-ack.sh

# 4. End-to-end with phone — see E2E_TEST.md
```

## What it does

1. **Backs up** the SQLite DB and the two files it will edit
   (alarm-notifier.js + bootstrap), under `$CFLEX_API_DIR/.backups/push-ack-<TS>/`.
2. **Applies migrations** 002 + 003 idempotently (checks for existing table /
   columns before running).
3. **Copies** `expo-push-notifier.js`, `fms-push.routes.js`, `fms-ack.routes.js`
   into the running tree.
4. **Patches** the bootstrap file to mount the two new routes (idempotent: greps
   first; uses awk to insert after the existing `fms.routes` mount).
5. **Patches** `alarm-notifier.js` to require + dispatch through Expo Push
   (idempotent: skips if `expo-push-notifier` already imported).
6. **Syntax-checks** every touched file with `node --check`. If any fails,
   restore from the backup directory and re-try.
7. **Restarts** PM2 process.

## Env overrides

```bash
CFLEX_API_DIR=/opt/cflex-v2/cflex-api          # default
DB_PATH=$CFLEX_API_DIR/cflex.db                # default
PM2_PROCESS=cflex-api-v2                       # default
```

## Rollback

```bash
./rollback-push-ack.sh /opt/cflex-v2/cflex-api/.backups/push-ack-<TS>
```

## Why this is safe to run on prod

- Every file edit is idempotent and shown in dry-run mode first.
- DB snapshot is taken BEFORE any migration.
- New files (`expo-push-notifier.js`, the two route files) are additive — they
  do nothing unless mounted/required.
- The two patches are minimal (1 require line + 1 try/catch block + 1 route mount).
- `node --check` runs on every touched file before restart — syntax errors stop
  the script BEFORE PM2 restarts.

The only "live" change is the two patches. If anything goes wrong, the backups
let you roll back in seconds.
