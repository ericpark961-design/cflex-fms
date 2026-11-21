#!/usr/bin/env bash
# HAEA mirror lab — SAT 7 backup / restore rehearsal on db01 (PG_BACKUP_RESTORE.md §6 B1–B11), WO-INT-015.
# The lab db01 is the rehearsal VM. Apps are stopped during each restore (doc §3 step 0).
# Restores use install/cflex-pg-recover (the image's own start script cannot finish a recovery).
#
#   ./sat7-backup.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
S=.state/ssh_config; REPO="$(cd ../.. && pwd)"
q() { grep -vE 'post-quantum|store now|upgraded|Permanently added' || true; }
say() { printf '\n%s  %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
db() { ssh -F $S db01 "$@" 2>&1 | q; }
T_=/tmp/cflex-tools; CA=$T_/cflex-as
sql() { ssh -F $S db01 "sudo $CA podman exec cflex-postgres psql -d cflex -Atc \"$1\"" 2>/dev/null; }
apps() { for n in app01 app02; do ssh -F $S $n "sudo $CA systemctl --user $1 cflex-console" 2>&1 | q; done; }
counts() { sql "select 'devices='||(select count(*) from devices)||' users='||(select count(*) from users)||' open_alarms='||(select count(*) from alarms where state='open')||' marker_rows='||coalesce((select count(*) from pg_tables where tablename='sat7_marker'),0)"; }
archiver() { sql "select archived_count||' archived, '||failed_count||' failed, last '||coalesce(last_archived_wal,'-')||coalesce(', last failed '||last_failed_wal,'') from pg_stat_archiver"; }
B=/opt/data/backup; D=$(date -u +%Y%m%d)
BK="sudo $CA env CFLEX_BACKUP_DIR=$B CFLEX_BACKUP_KEEP_DAYS=14 'CFLEX_PG_EXEC=/usr/bin/podman exec cflex-postgres' /bin/bash /opt/app/cflex/bin/cflex-pg-backup.sh"
fresh() { db "sudo $CA sh -c 'test -d $B/base-$D && mv $B/base-$D $B/base-$D.\$(date -u +%H%M%S)'; s=\$(date +%s%N); $BK </dev/null | grep -E 'complete|ERROR'; echo \"took \$(( (\$(date +%s%N)-s)/1000000 )) ms\""; }

for n in db01 app01 app02; do ssh -F $S $n "mkdir -p $T_" 2>/dev/null; for f in cflex-as cflex-pg-recover; do ssh -F $S $n "cat > $T_/$f && chmod 755 $T_/$f" < "$REPO/install/$f" 2>&1 | q; done; done

say "B1 B3 — settings, WAL archive"
echo "wal_level/archive_mode: $(sql "select current_setting('wal_level')||' '||current_setting('archive_mode')")"
echo "archiver: $(archiver) · files in $B/wal: $(ssh -F $S db01 "sudo ls $B/wal | wc -l" 2>/dev/null)"

say "B4 — DB stopped: backup must exit 1, log the cause, keep every earlier set"
next=$(date -u -v+1d +%Y%m%d 2>/dev/null || date -u -d '+1 day' +%Y%m%d)
db "sudo ls $B | grep -c '^base-' | sed 's/^/sets before: /'; sudo $CA systemctl --user stop cflex-postgres
  sudo $CA env CFLEX_BACKUP_DATE=$next CFLEX_BACKUP_DIR=$B 'CFLEX_PG_EXEC=/usr/bin/podman exec cflex-postgres' /bin/bash /opt/app/cflex/bin/cflex-pg-backup.sh >/dev/null 2>&1 </dev/null; echo \"exit \$?\"
  sudo ls $B | grep -c '^base-' | sed 's/^/sets after: /'; sudo test -e $B/base-$next && echo 'partial set left!' || echo 'no partial set'
  sudo tail -1 $B/backup.log; sudo $CA systemctl --user start cflex-postgres"
sleep 15

say "B5 — retention: a complete set dated 20 days ago goes, the newest stays"
old=$(date -u -v-20d +%Y%m%d 2>/dev/null || date -u -d '-20 days' +%Y%m%d)
db "sudo $CA sh -c 'mkdir -p $B/base-$old && date -u > $B/base-$old/CFLEX_BACKUP_OK'; $BK </dev/null | tail -1; sudo ls $B | grep base-"

say "B2 B8 — fresh base backup (an earlier set of today is moved aside: a same-day re-run is a no-op)"
fresh; db "sudo du -sh $B/base-$D $B/wal"

say "B7 — PITR: marker → T → marker dropped → restore to T"
sql "drop table if exists sat7_marker; create table sat7_marker(at timestamptz default now()); insert into sat7_marker default values; select pg_switch_wal()" >/dev/null
sleep 2; T=$(sql "select to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')||'+00'"); sleep 2
echo "at T=$T: $(counts)"
sql "drop table sat7_marker; select pg_switch_wal()" >/dev/null; sleep 3
echo "after drop: $(counts)"
apps stop
db "sudo $T_/cflex-pg-recover --set $B/base-$D --time '$T' --yes | grep -vE '^next:|^  [0-9]\.|^       |can be deleted'"
echo "restored: $(counts)"
apps start

say "B9 — after PITR: base backup on the new timeline, archiving (new segment names, no collision)"
fresh; sql "select pg_switch_wal()" >/dev/null; sleep 5
echo "archiver: $(archiver)"

say "B6 — base restore (§3, --immediate) from that set; counts must match the set"
sql "drop table if exists sat7_marker" >/dev/null
fresh; C1=$(counts); echo "at backup: $C1"
apps stop
db "sudo $T_/cflex-pg-recover --set $B/base-$D --immediate --yes | grep -vE '^next:|^  [0-9]\.|^       |can be deleted'"
C2=$(counts); echo "restored:  $C2  → $([ "$C1" = "$C2" ] && echo MATCH || echo DIFFERENT)"
apps start; sleep 30
sql "select pg_switch_wal()" >/dev/null; sleep 5
echo "archiver: $(archiver)"
fresh

say "B10 — no secret in backup log / journal / server log; permissions"
db "P=\$(sudo cat /opt/app/cflex/secrets/db/pg.pass); echo \"pg.pass in backup.log: \$(sudo grep -cF -- \"\$P\" $B/backup.log), in today's server log: \$(sudo sh -c \"grep -cF -- '\$P' /opt/data/pgsql/userdata/log/*.log\" | paste -sd+ | bc), in journal since restore: \$(sudo journalctl --since '-15min' -o cat | grep -cF -- \"\$P\")\"
  sudo stat -c '%U %a %n' $B $B/wal $B/base-$D"
