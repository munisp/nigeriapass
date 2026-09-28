# Migrations

- `0000`–`0007`: drizzle-kit generated (Postgres dialect), tracked in `meta/_journal.json`.
- `0009_audit_v13_hardening.sql`: **hand-written** consolidated hardening
  migration (audit v13). It is idempotent (`IF NOT EXISTS` / `DO $$ ...
  WHEN duplicate_object`) and covers enum extensions, new tables
  (`nfc_provisioning_events`, `audit_logs`, `kyc_status_history`, `sessions`,
  `consents`, `refunds`, `disputes`, `fraud_labels`, `agents`), the
  `UNIQUE(wallet_transactions."externalRef")` and
  `UNIQUE(userId, type, draftId)` idempotency guards, the
  `CHECK (balanceKobo >= 0)` invariant, and FK constraints.
  It is NOT in the drizzle meta journal — apply it with
  `psql "$DATABASE_URL" -f drizzle/migrations/0009_audit_v13_hardening.sql`
  (or via your migration runner) after `drizzle-kit migrate`.
- `0010_performance_indexes.sql`: hand-written performance indexes (see file
  header).
- The `drizzle/0000..0002_*.sql` files in the drizzle/ root are stale legacy
  artifacts (wrong dialect, partial coverage) and are superseded by
  `drizzle/migrations/*`. Do not apply them.
