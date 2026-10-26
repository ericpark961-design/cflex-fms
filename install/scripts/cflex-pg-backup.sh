#!/bin/bash
# cflex-pg-backup.sh — daily PostgreSQL base backup on db01 (spec 01 §2.3, WO-INT-008).
#
#   pg_basebackup -X stream → $BACKUP_DIR/base-YYYYMMDD/   (tar + gzip, backup_manifest)
#   WAL archive              → $BACKUP_DIR/wal/             (written by archive_command, cflex-postgresql.conf)
#   retention                  base sets older than $KEEP_DAYS days are deleted, and the WAL
#                              older than the oldest set that is kept; the newest complete set is never deleted.
#
# Run by cflex-pg-backup.timer (daily). Container profile: pg_basebackup runs inside
# cflex-postgres (CFLEX_PG_EXEC="podman exec cflex-postgres"), where /opt/data/backup
# is mounted at the same path. Bare profile: runs as postgres on the host.
# It connects over the local socket as the server's own user; no password is involved.
#
# Exit: 0 backup made (or today's already complete), 1 backup failed, 2 configuration problem.
# Every step is logged to stdout (journald) and $LOG. Restore: docs/install/PG_BACKUP_RESTORE.md.
set -uo pipefail

BACKUP_DIR="${CFLEX_BACKUP_DIR:-/opt/data/backup}"
KEEP_DAYS="${CFLEX_BACKUP_KEEP_DAYS:-14}"
WAL_DIR="${CFLEX_WAL_DIR:-$BACKUP_DIR/wal}"
LOG="${CFLEX_BACKUP_LOG:-$BACKUP_DIR/backup.log}"
# Word-split on purpose: "podman exec cflex-postgres" → three words.
EXEC="${CFLEX_PG_EXEC:-}"
PG_BASEBACKUP="${CFLEX_PG_BASEBACKUP:-pg_basebackup}"
# For tests and for a re-run after midnight: the day the set is named after (UTC).
TODAY="${CFLEX_BACKUP_DATE:-$(date -u +%Y%m%d)}"

log() {
  local line
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $1 $2"
  echo "$line"
  echo "$line" >>"$LOG" 2>/dev/null || true
}

# days since epoch of YYYYMMDD (GNU date on RHEL; BSD date for a developer Mac)
epoch_day() {
  local s
  s=$(date -u -d "$1" +%s 2>/dev/null) || s=$(date -u -j -f %Y%m%d "$1" +%s 2>/dev/null) || return 1
  echo $((s / 86400))
}

if [[ ! "$KEEP_DAYS" =~ ^[0-9]+$ ]] || ((KEEP_DAYS < 1)); then
  echo "cflex-pg-backup: CFLEX_BACKUP_KEEP_DAYS must be a whole number of days >= 1 (got '$KEEP_DAYS')" >&2
  exit 2
fi
if [[ ! "$TODAY" =~ ^[0-9]{8}$ ]] || ! today_n=$(epoch_day "$TODAY"); then
  echo "cflex-pg-backup: bad date '$TODAY'" >&2
  exit 2
fi
if [[ ! -d "$BACKUP_DIR" || ! -w "$BACKUP_DIR" ]]; then
  echo "cflex-pg-backup: $BACKUP_DIR is not a writable directory" >&2
  exit 2
fi
mkdir -p "$WAL_DIR" || { log ERROR "cannot create $WAL_DIR"; exit 2; }

target="$BACKUP_DIR/base-$TODAY"
partial="$target.partial"
started="$BACKUP_DIR/.started-$TODAY"

if [[ -f "$target/CFLEX_BACKUP_OK" ]]; then
  log INFO "base-$TODAY already complete — nothing to do"
else
  # A set without its OK marker is an interrupted run: start that day over.
  rm -rf "$partial" "$target"
  touch "$started"
  log INFO "pg_basebackup → $target (WAL streamed, tar+gzip)"
  # shellcheck disable=SC2086
  $EXEC "$PG_BASEBACKUP" -D "$partial" -X stream -F tar -z --checkpoint=fast --label="cflex-$TODAY" --no-password >>"$LOG" 2>&1
  rc=$?
  if ((rc != 0)); then
    rm -rf "$partial" "$started"
    log ERROR "pg_basebackup failed (exit $rc) — see $LOG; previous sets kept"
    exit 1
  fi
  if [[ ! -s "$partial/base.tar.gz" ]]; then
    rm -rf "$partial" "$started"
    log ERROR "pg_basebackup reported success but $partial/base.tar.gz is missing or empty"
    exit 1
  fi
  mv "$partial" "$target"
  # The start time decides which WAL this set needs (mv keeps the mtime).
  mv "$started" "$target/CFLEX_BACKUP_STARTED"
  date -u +%Y-%m-%dT%H:%M:%SZ >"$target/CFLEX_BACKUP_OK"
  log INFO "base-$TODAY complete ($(du -sh "$target" 2>/dev/null | cut -f1))"
fi

# ── retention ────────────────────────────────────────────────────────────────
newest_ok=""
for d in "$BACKUP_DIR"/base-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]; do
  [[ -f "$d/CFLEX_BACKUP_OK" ]] && newest_ok="$d"
done
removed=0
for d in "$BACKUP_DIR"/base-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9] "$BACKUP_DIR"/base-*.partial; do
  [[ -e "$d" ]] || continue
  name="${d##*/base-}"
  name="${name%.partial}"
  n=$(epoch_day "$name") || continue
  if ((today_n - n > KEEP_DAYS)) && [[ "$d" != "$newest_ok" ]]; then
    rm -rf "$d" && removed=$((removed + 1)) && log INFO "removed ${d##*/} (older than $KEEP_DAYS days)"
  fi
done

# WAL: everything archived before the oldest kept set started is no longer needed by any set.
oldest=""
for d in "$BACKUP_DIR"/base-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]; do
  if [[ -f "$d/CFLEX_BACKUP_OK" && -f "$d/CFLEX_BACKUP_STARTED" ]]; then oldest="$d"; break; fi
done
if [[ -n "$oldest" ]]; then
  wal_removed=$(find "$WAL_DIR" -maxdepth 1 -type f ! -newer "$oldest/CFLEX_BACKUP_STARTED" -print -delete | wc -l | tr -d ' ')
  log INFO "retention: $removed set(s) removed, $wal_removed WAL file(s) older than ${oldest##*/} removed"
else
  log WARN "retention: no complete set — WAL kept as is"
fi
exit 0
