-- ─────────────────────────────────────────────────────────────────────────────
-- NigerianPass postgres hardening checklist (audit AUDIT_REPORT_V12.md).
-- Postgres is the ONLY production-grade infra today (grade 3); these are the
-- gaps the audit flagged plus operational must-haves. Apply statements as
-- migrations land; this file is documentation-as-SQL, not a blind script.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Observability: pg_stat_statements (requires shared_preload_libraries,
--    already set in docker-compose.infra.yml command flags).
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Top offenders:
--   SELECT query, calls, mean_exec_time, rows
--   FROM pg_stat_statements ORDER BY mean_exec_time * calls DESC LIMIT 20;

-- 2) Money integrity (audit: wallet_transactions.externalRef NOT unique →
--    duplicate Paystack/Flutterwave webhook retries can double-credit).
--    Partial unique index because externalRef is nullable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wtx_external_ref
  ON "wallet_transactions" ("externalRef")
  WHERE "externalRef" IS NOT NULL;

-- Balance can never go negative at the storage layer (belt-and-suspenders
-- alongside application checks; toll charges must not drive balance < 0).
ALTER TABLE "wallet_accounts"
  ADD CONSTRAINT chk_wallet_balance_nonneg CHECK ("balanceKobo" >= 0);

ALTER TABLE "wallet_accounts"
  ADD CONSTRAINT chk_wallet_daily_spent_nonneg CHECK ("dailySpentKobo" >= 0);

-- Transaction amounts are always positive; direction is in `type`.
ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT chk_wtx_amount_positive CHECK ("amountKobo" > 0);

-- 3) FK referential integrity checklist (audit noted several soft relations):
--    Verify these exist; add as separate migrations if missing:
--      wallet_transactions.walletId      → wallet_accounts.id      (ON DELETE RESTRICT)
--      wallet_accounts.userId            → users.id                (ON DELETE CASCADE)
--      kyc_applications.userId           → users.id
--      sync_queue.userId                 → users.id
--      nfc_batch_jobs / device tables    → owning user/plaza FKs
--    Detection query:
--      SELECT conrelid::regclass, conname FROM pg_constraint
--      WHERE contype = 'f' AND connamespace = 'public'::regnamespace;

-- 4) Index checklist (hot paths from audit):
--      wallet_transactions (walletId, createdAt DESC)   — wallet history paging
--      wallet_transactions (type)                        — already idx_wtx_type
--      kyc_applications (status)                         — review queue
--      otp_codes (phone, expiresAt)                      — OTP verify hot path
--    Existing (from drizzle/schema.ts): idx_wallet_userId, idx_wtx_walletId,
--    idx_wtx_type, idx_wallet_userId. Add the composite + status indexes:
CREATE INDEX IF NOT EXISTS idx_wtx_wallet_created
  ON "wallet_transactions" ("walletId", "createdAt" DESC);

-- 5) Connection pooling notes (pgbouncer-style):
--    - App pool: pg.Pool max=20 per replica (max_connections=200 budgeted).
--    - Add pgbouncer (transaction pooling) at >3 replicas or >100 conns
--      sustained:  docker run -p 6432:6432 pgbouncer/pgbouncer
--      pool_mode=transaction  default_pool_size=50
--    - CAUTION with transaction pooling: no prepared statements (pgBouncer <
--      1.21) and no session-level SET — drizzle node-postgres defaults are
--      compatible (unnamed portals).
--    - Health: SELECT count(*) FROM pg_stat_activity GROUP BY state;

-- 6) Statement/lock timeouts — never let a bad query hold wallet rows:
ALTER DATABASE nigerianpass SET statement_timeout = '15s';
ALTER DATABASE nigerianpass SET lock_timeout = '5s';
ALTER DATABASE nigerianpass SET idle_in_transaction_session_timeout = '30s';

-- 7) Roles: app connects as a least-privilege role, not the superuser:
--      CREATE ROLE np_app LOGIN PASSWORD '...';
--      GRANT CONNECT ON DATABASE nigerianpass TO np_app;
--      GRANT USAGE ON SCHEMA public TO np_app;
--      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO np_app;
--      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO np_app;
--      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO np_app;
--      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO np_app;
--      REVOKE CREATE ON SCHEMA public FROM np_app;  -- migrations run as owner only

-- 8) Partitioning note: wallet_transactions and audit-style tables grow
--    unbounded. At >50M rows partition by createdAt (monthly RANGE) —
--    declarative partitioning, keep the same table name.
