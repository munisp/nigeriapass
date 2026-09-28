#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# NigerianPass postgres backup (nightly logical dump + WAL archiving notes).
#
# Usage:
#   ./infra/postgres/backup.sh [output_dir]
# Env: POSTGRES_HOST (default localhost), POSTGRES_PORT (5432),
#      POSTGRES_USER, POSTGRES_DB, PGPASSWORD (or ~/.pgpass), S3_BUCKET (optional)
#
# Strategy:
#   1. pg_dump custom format (compressed, restorable per-table) — nightly cron.
#   2. WAL archiving for PITR — see notes at the bottom; requires wal_level=
#      replica (already set) + archive_command in production.
# Retention: 14 nightly dumps locally; push to object storage for 35-day PITR.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

OUT_DIR="${1:-/var/backups/nigerianpass}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${OUT_DIR}/nigerianpass_${TS}.dump"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

mkdir -p "$OUT_DIR"

echo "[backup] pg_dump ${POSTGRES_DB:-nigerianpass} → ${FILE}"
pg_dump \
  --host="${POSTGRES_HOST:-localhost}" \
  --port="${POSTGRES_PORT:-5432}" \
  --username="${POSTGRES_USER:-nigerianpass}" \
  --dbname="${POSTGRES_DB:-nigerianpass}" \
  --format=custom \
  --compress=6 \
  --no-owner --no-privileges \
  --file="$FILE"

# Verify the dump is readable before declaring success.
pg_restore --list "$FILE" >/dev/null
echo "[backup] verified: $(du -h "$FILE" | cut -f1)"

# Optional: ship to object storage (S3-compatible; e.g. AWS S3, Cloudflare R2,
# or a Lagos-region bucket for latency/data-residency).
if [[ -n "${S3_BUCKET:-}" ]]; then
  aws s3 cp "$FILE" "s3://${S3_BUCKET}/postgres/$(basename "$FILE")" --only-show-errors
  echo "[backup] uploaded to s3://${S3_BUCKET}/postgres/"
fi

# Retention: prune local dumps older than RETENTION_DAYS.
find "$OUT_DIR" -name 'nigerianpass_*.dump' -mtime "+${RETENTION_DAYS}" -delete
echo "[backup] done"

# ── PITR / WAL ARCHIVING (production) ─────────────────────────────────────────
# Logical dumps restore to the nightly point only. For point-in-time recovery
# (e.g. "undo everything after 14:03 today") enable WAL archiving:
#
#   postgres.conf / compose command flags:
#     archive_mode = on
#     archive_command = 'aws s3 cp %p s3://BUCKET/wal/%f'   # or wal-g / pgBackRest
#     restore_command = 'aws s3 cp s3://BUCKET/wal/%f %p'
#
#   Take a base backup weekly:
#     pg_basebackup -h $HOST -U replication -Ft -z -D basebackup_$(date +%F)
#
#   Recommended instead of hand-rolling: pgBackRest or wal-g with the
#   compose postgres image; both handle base backups + WAL + retention.
#
# Restore drill (run quarterly):
#   createdb restore_test && pg_restore -d restore_test "$FILE"
# ─────────────────────────────────────────────────────────────────────────────
