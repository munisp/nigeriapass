#!/bin/sh
# snapshot.sh — create a timestamped tar.gz snapshot of the project source.
#
# Snapshots go to ~/.fs-guard/snapshots/nigerianpass-<UTC-timestamp>.tar.gz
# Retention: the newest 10 snapshots are kept; older ones are pruned.
#
# Excludes generated/disposable content (node_modules, dist, .git, logs) —
# this is a *source* safety net, not a full backup.
#
# POSIX sh; depends only on tar, gzip, ls, coreutils.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
PROJECT_NAME=$(basename "$REPO_ROOT")
SNAP_DIR="${FSGUARD_SNAP_DIR:-$HOME/.fs-guard/snapshots}"
KEEP="${FSGUARD_KEEP:-10}"

mkdir -p "$SNAP_DIR"

TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$SNAP_DIR/$PROJECT_NAME-$TS.tar.gz"

cd "$REPO_ROOT"
# tar exits 1 ("file changed as we read it") when files are modified during
# the snapshot — harmless for a best-effort safety net, so accept rc 0 and 1.
rc=0
tar -czf "$OUT" \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./.git' \
  --exclude='./.webdev' \
  --exclude='./.manus-logs' \
  --exclude='./coverage' \
  . 2>/dev/null || rc=$?
if [ "$rc" -gt 1 ] || [ ! -s "$OUT" ]; then
  echo "[fs-guard] ERROR: snapshot failed (tar exit $rc)" >&2
  rm -f "$OUT"
  exit 1
fi
[ "$rc" -eq 1 ] && echo "[fs-guard] note: some files changed mid-snapshot (concurrent edits); archive is still usable" >&2

echo "[fs-guard] snapshot created: $OUT ($(du -h "$OUT" | cut -f1))"

# Retention: keep newest $KEEP, delete the rest.
ls -1t "$SNAP_DIR/$PROJECT_NAME"-*.tar.gz 2>/dev/null | tail -n "+$((KEEP + 1))" |
  while IFS= read -r old; do
    echo "[fs-guard] pruning old snapshot: $old"
    rm -f -- "$old"
  done

# Print path on the last line for scripting: SNAPSHOT=$(snapshot.sh | tail -1)
printf '%s\n' "$OUT"
