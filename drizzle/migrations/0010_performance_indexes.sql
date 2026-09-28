-- =============================================================================
-- 0010_performance_indexes.sql
-- Performance indexes for NigerianPass — matched to actual query patterns.
--
-- Pure SQL, idempotent (IF NOT EXISTS). Safe to run multiple times.
-- Column names use drizzle's quoted camelCase identifiers (e.g. "userId").
--
-- NOTE: drizzle-kit manages drizzle/migrations/meta/_journal.json. When this
-- file is applied outside `drizzle-kit migrate` (e.g. psql -f), record it in
-- your migration tracking accordingly. No schema.ts changes are required —
-- these are additive database-level indexes only.
--
-- After applying, run ANALYZE (included at the bottom) so the planner picks
-- up the new indexes immediately.
-- =============================================================================

BEGIN;

-- ── kyc_applications ────────────────────────────────────────────────────────
-- Pattern: user dashboard — "my applications, newest first, filtered by status"
-- Existing single-column indexes: idx_kyc_userId, idx_kyc_status, idx_kyc_type
CREATE INDEX IF NOT EXISTS idx_kyc_user_status
  ON kyc_applications ("userId", status);

-- Pattern: admin review queue — "all apps by status, oldest first (FIFO review)"
CREATE INDEX IF NOT EXISTS idx_kyc_status_created
  ON kyc_applications (status, "createdAt" ASC);

-- Pattern: reference lookup is case-insensitive user input (e.g. drv-xkqp7)
CREATE INDEX IF NOT EXISTS idx_kyc_reference_lower
  ON kyc_applications (lower("referenceId"));

-- Partial: hot subset actually shown in the admin review queue.
-- Small index → cheap to maintain, always in memory.
CREATE INDEX IF NOT EXISTS idx_kyc_pending_review
  ON kyc_applications ("createdAt" ASC)
  WHERE status IN ('submitted', 'under_review');

-- ── wallet_transactions ─────────────────────────────────────────────────────
-- Pattern: wallet history — "transactions for wallet X, newest first"
-- Replaces seq-scan + sort for the most common wallet read.
CREATE INDEX IF NOT EXISTS idx_wtx_wallet_created_desc
  ON wallet_transactions ("walletId", "createdAt" DESC);

-- Pattern: payment reconciliation / webhook idempotency lookup by provider ref.
-- externalRef is nullable; enforce uniqueness only where present so multiple
-- NULL toll_charge rows stay legal.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wtx_external_ref_unique
  ON wallet_transactions ("externalRef")
  WHERE "externalRef" IS NOT NULL;

-- Partial: unreconciled topups (webhook not yet confirmed) — nightly reconcile
-- job scans this subset repeatedly.
CREATE INDEX IF NOT EXISTS idx_wtx_pending_topups
  ON wallet_transactions ("createdAt" ASC)
  WHERE type = 'topup' AND "externalRef" IS NOT NULL;

-- ── otp_codes ───────────────────────────────────────────────────────────────
-- Pattern: verify — "latest unexpired code for this phone"
CREATE INDEX IF NOT EXISTS idx_otp_phone_expires
  ON otp_codes (phone, "expiresAt" DESC);

-- Partial: active (unused, unexpired-at-insert) codes only. Verification only
-- ever reads this subset; expired rows are pure dead weight.
CREATE INDEX IF NOT EXISTS idx_otp_active
  ON otp_codes (phone, "expiresAt" DESC)
  WHERE used = false;

-- ── sync_queue ──────────────────────────────────────────────────────────────
-- Pattern: client offline replay status — "this user's pending/failed items"
CREATE INDEX IF NOT EXISTS idx_sq_user_status
  ON sync_queue ("userId", status);

-- Partial: worker queue — items awaiting processing, ordered by queue time.
CREATE INDEX IF NOT EXISTS idx_sq_pending
  ON sync_queue ("queuedAt" ASC)
  WHERE status IN ('pending', 'failed');

-- ── ussd_sessions ───────────────────────────────────────────────────────────
-- Pattern: webhook continuation — session lookup happens on EVERY USSD
-- interaction (p99-sensitive; Africa's Talking 10s timeout). sessionId has a
-- UNIQUE constraint already, but an explicit index keeps intent clear and is
-- a no-op if the planner already uses the constraint index.
CREATE INDEX IF NOT EXISTS idx_ussd_session_id
  ON ussd_sessions ("sessionId");

-- Pattern: per-subscriber analytics — "sessions for this phone number"
CREATE INDEX IF NOT EXISTS idx_ussd_phone
  ON ussd_sessions ("phoneNumber", "startedAt" DESC);

-- ── qr_scan_logs ────────────────────────────────────────────────────────────
-- NOTE: schema columns are "deviceSerial"/"scannedAt" (not device_id/scanned_at).
-- Pattern: security audit — "recent scans for device X"
CREATE INDEX IF NOT EXISTS idx_qr_device_scanned
  ON qr_scan_logs ("deviceSerial", "scannedAt" DESC);

-- Partial: failed scans only — fraud review dashboard reads just these.
CREATE INDEX IF NOT EXISTS idx_qr_invalid_scans
  ON qr_scan_logs ("scannedAt" DESC)
  WHERE valid = false;

-- ── toll_devices ────────────────────────────────────────────────────────────
-- Pattern: admin device grid — "devices at plaza X with status Y"
CREATE INDEX IF NOT EXISTS idx_device_plaza_status
  ON toll_devices (plaza, status);

-- Partial: devices needing attention (anything not cleanly online).
CREATE INDEX IF NOT EXISTS idx_device_attention
  ON toll_devices (plaza)
  WHERE status IN ('offline', 'warning', 'maintenance');

-- ── device_alert_logs ───────────────────────────────────────────────────────
-- NOTE: schema columns are "deviceId"/"resolvedAt" (resolution timestamp,
-- not a boolean). Pattern: alert history per device, newest first.
CREATE INDEX IF NOT EXISTS idx_dal_device_resolved
  ON device_alert_logs ("deviceId", "resolvedAt" DESC);

COMMIT;

-- ── Statistics refresh ──────────────────────────────────────────────────────
-- ANALYZE updates planner statistics so the new indexes are used immediately.
-- Cheap on these table sizes; safe to re-run. For very large deployments run
-- during off-peak or use ANALYZE on individual tables.
ANALYZE kyc_applications;
ANALYZE wallet_transactions;
ANALYZE otp_codes;
ANALYZE sync_queue;
ANALYZE ussd_sessions;
ANALYZE qr_scan_logs;
ANALYZE toll_devices;
ANALYZE device_alert_logs;
