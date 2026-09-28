-- =============================================================================
-- 0009_audit_v13_hardening.sql
-- =============================================================================
-- Consolidated Postgres-dialect hardening migration (audit v13, P0-11).
--
-- Covers:
--   * user_role enum extension: agent, operator, reviewer, support, installer
--   * device_status enum extension: lost, stolen, decommissioned
--   * kyc_applications.draftId + UNIQUE (userId, type, draftId) idempotency
--   * UNIQUE(wallet_transactions."externalRef") — double-credit guard
--   * CHECK (wallet_accounts."balanceKobo" >= 0)
--   * ussd_sessions.state / lastActivityAt — DB-backed session state
--   * New tables: nfc_provisioning_events, audit_logs, kyc_status_history,
--     sessions, consents, refunds, disputes, fraud_labels, agents
--   * FK constraints: kyc_applications.userId → users,
--     wallet_transactions.walletId → wallet_accounts,
--     device_alert_logs.deviceId → toll_devices
--   * CREATE TABLE IF NOT EXISTS for every table in drizzle/schema.ts so the
--     migration is sufficient on a fresh database as well.
--
-- Idempotent: safe to run multiple times. Apply with:
--   psql "$DATABASE_URL" -f drizzle/migrations/0009_audit_v13_hardening.sql
-- NOTE: drizzle/meta journal is NOT machine-generated for this file (it was
-- hand-written per audit v13). See drizzle/migrations/README.md.
-- =============================================================================

-- ── Enum extensions (must run outside a transaction on PG < 12) ─────────────
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'agent';
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'operator';
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'reviewer';
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'support';
ALTER TYPE "public"."user_role" ADD VALUE IF NOT EXISTS 'installer';
ALTER TYPE "public"."device_status" ADD VALUE IF NOT EXISTS 'lost';
ALTER TYPE "public"."device_status" ADD VALUE IF NOT EXISTS 'stolen';
ALTER TYPE "public"."device_status" ADD VALUE IF NOT EXISTS 'decommissioned';

-- New enums (guarded for fresh databases where they may not exist yet)
DO $$ BEGIN
  CREATE TYPE "public"."consent_type" AS ENUM('terms_of_service', 'privacy_policy', 'marketing', 'data_processing', 'location_tracking');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "public"."refund_status" AS ENUM('pending', 'awaiting_second_approval', 'approved', 'rejected', 'processed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "public"."agent_status" AS ENUM('active', 'suspended', 'deactivated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Base tables (IF NOT EXISTS — no-ops when 0000-0007 already applied) ─────
CREATE TABLE IF NOT EXISTS "users" (
  "id" serial PRIMARY KEY NOT NULL,
  "openId" varchar(64) NOT NULL,
  "name" text,
  "email" varchar(320),
  "loginMethod" varchar(64),
  "role" "user_role" DEFAULT 'user' NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  "lastSignedIn" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "users_openId_unique" UNIQUE("openId")
);

CREATE TABLE IF NOT EXISTS "kyc_applications" (
  "id" serial PRIMARY KEY NOT NULL,
  "referenceId" varchar(32) NOT NULL,
  "userId" integer,
  "type" "kyc_type" NOT NULL,
  "status" "kyc_status" DEFAULT 'draft' NOT NULL,
  "formData" jsonb NOT NULL,
  "kycScore" integer,
  "reviewNotes" text,
  "reviewedBy" integer,
  "reviewedAt" timestamp,
  "fromOfflineQueue" boolean DEFAULT false NOT NULL,
  "clientVersion" integer DEFAULT 1 NOT NULL,
  "draftId" varchar(64),
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "kyc_applications_referenceId_unique" UNIQUE("referenceId")
);

CREATE TABLE IF NOT EXISTS "wallet_accounts" (
  "id" serial PRIMARY KEY NOT NULL,
  "userId" integer NOT NULL,
  "tigerBeetleId" varchar(40) NOT NULL,
  "balanceKobo" bigint DEFAULT 0 NOT NULL,
  "dailyCapKobo" bigint DEFAULT 500000 NOT NULL,
  "dailySpentKobo" bigint DEFAULT 0 NOT NULL,
  "lastBalanceSync" timestamp DEFAULT now() NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "wallet_accounts_userId_unique" UNIQUE("userId"),
  CONSTRAINT "wallet_accounts_tigerBeetleId_unique" UNIQUE("tigerBeetleId")
);

CREATE TABLE IF NOT EXISTS "wallet_transactions" (
  "id" serial PRIMARY KEY NOT NULL,
  "walletId" integer NOT NULL,
  "type" "tx_type" NOT NULL,
  "amountKobo" bigint NOT NULL,
  "balanceAfterKobo" bigint NOT NULL,
  "description" text,
  "externalRef" varchar(128),
  "plazaId" varchar(32),
  "tigerBeetleTransferId" varchar(40),
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "sync_queue" (
  "id" serial PRIMARY KEY NOT NULL,
  "clientId" varchar(64) NOT NULL,
  "userId" integer,
  "procedure" varchar(128) NOT NULL,
  "payload" jsonb NOT NULL,
  "status" "sync_status" DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "lastError" text,
  "queuedAt" timestamp NOT NULL,
  "processedAt" timestamp,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "sync_queue_clientId_unique" UNIQUE("clientId")
);

CREATE TABLE IF NOT EXISTS "otp_codes" (
  "id" serial PRIMARY KEY NOT NULL,
  "phone" varchar(20) NOT NULL,
  "codeHash" varchar(128) NOT NULL,
  "used" boolean DEFAULT false NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "requestIp" varchar(45),
  "messageId" varchar(64),
  "expiresAt" timestamp NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "reconciliation_runs" (
  "id" serial PRIMARY KEY NOT NULL,
  "triggeredBy" varchar(16) DEFAULT 'scheduled' NOT NULL,
  "status" "reconcile_status" NOT NULL,
  "processed" integer DEFAULT 0 NOT NULL,
  "credited" integer DEFAULT 0 NOT NULL,
  "failed" integer DEFAULT 0 NOT NULL,
  "skipped" integer DEFAULT 0 NOT NULL,
  "errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "durationMs" integer DEFAULT 0 NOT NULL,
  "triggeredByUserId" integer,
  "startedAt" timestamp DEFAULT now() NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "resolvedAt" timestamp,
  "resolvedNote" varchar(500)
);

CREATE TABLE IF NOT EXISTS "nfc_batch_jobs" (
  "id" serial PRIMARY KEY NOT NULL,
  "jobRef" varchar(32) NOT NULL,
  "submittedBy" integer NOT NULL,
  "totalTags" integer NOT NULL,
  "provisioned" integer DEFAULT 0 NOT NULL,
  "failed" integer DEFAULT 0 NOT NULL,
  "status" "nfc_batch_job_status" DEFAULT 'pending' NOT NULL,
  "results" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "errorMessage" text,
  "durationMs" integer DEFAULT 0 NOT NULL,
  "startedAt" timestamp DEFAULT now() NOT NULL,
  "completedAt" timestamp,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "nfc_batch_jobs_jobRef_unique" UNIQUE("jobRef")
);

CREATE TABLE IF NOT EXISTS "toll_devices" (
  "id" serial PRIMARY KEY NOT NULL,
  "serial" varchar(64) NOT NULL,
  "name" varchar(128) NOT NULL,
  "type" "device_type" NOT NULL,
  "plaza" varchar(128) NOT NULL,
  "lane" varchar(64) NOT NULL,
  "status" "device_status" DEFAULT 'offline' NOT NULL,
  "firmware" varchar(32) DEFAULT '1.0.0' NOT NULL,
  "latestFirmware" varchar(32) DEFAULT '1.0.0' NOT NULL,
  "uptime" varchar(32) DEFAULT '0d 0h' NOT NULL,
  "cpu" integer DEFAULT 0 NOT NULL,
  "memory" integer DEFAULT 0 NOT NULL,
  "temp" integer DEFAULT 0 NOT NULL,
  "alerts" integer DEFAULT 0 NOT NULL,
  "lastSeen" timestamp DEFAULT now() NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "toll_devices_serial_unique" UNIQUE("serial")
);

CREATE TABLE IF NOT EXISTS "device_alert_logs" (
  "id" serial PRIMARY KEY NOT NULL,
  "deviceId" integer NOT NULL,
  "serial" varchar(64) NOT NULL,
  "plaza" varchar(128) NOT NULL,
  "alertsCleared" integer DEFAULT 0 NOT NULL,
  "note" text,
  "resolvedByUserId" integer NOT NULL,
  "resolvedByName" varchar(128),
  "resolvedAt" timestamp DEFAULT now() NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "ussd_sessions" (
  "id" serial PRIMARY KEY NOT NULL,
  "sessionId" varchar(128) NOT NULL,
  "phoneNumber" varchar(32) NOT NULL,
  "serviceCode" varchar(32),
  "menuPath" text,
  "completed" boolean DEFAULT false NOT NULL,
  "interactionCount" integer DEFAULT 0 NOT NULL,
  "durationSeconds" integer,
  "countryCode" varchar(4),
  "state" jsonb,
  "lastActivityAt" timestamp DEFAULT now() NOT NULL,
  "startedAt" timestamp DEFAULT now() NOT NULL,
  "endedAt" timestamp,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "ussd_sessions_sessionId_unique" UNIQUE("sessionId")
);

CREATE TABLE IF NOT EXISTS "qr_scan_logs" (
  "id" serial PRIMARY KEY NOT NULL,
  "deviceSerial" varchar(64) NOT NULL,
  "scannedUri" text NOT NULL,
  "valid" boolean NOT NULL,
  "rejectionReason" varchar(128),
  "plazaName" varchar(128),
  "lane" varchar(32),
  "operatorUserId" integer,
  "operatorName" varchar(128),
  "scannedAt" timestamp DEFAULT now() NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

-- ── New audit v13 tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "nfc_provisioning_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "refId" varchar(48) NOT NULL,
  "tagId" varchar(64) NOT NULL,
  "vehicleRef" varchar(64) NOT NULL,
  "keyHexPrefix" varchar(16) NOT NULL,
  "signature" varchar(32) NOT NULL,
  "provisionedBy" integer NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "nfc_provisioning_events_refId_unique" UNIQUE("refId")
);

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" serial PRIMARY KEY NOT NULL,
  "actorUserId" integer,
  "actorRole" varchar(32),
  "action" varchar(64) NOT NULL,
  "entity" varchar(64) NOT NULL,
  "entityId" varchar(128) NOT NULL,
  "diff" jsonb,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "kyc_status_history" (
  "id" serial PRIMARY KEY NOT NULL,
  "referenceId" varchar(32) NOT NULL,
  "fromStatus" varchar(32),
  "toStatus" varchar(32) NOT NULL,
  "changedBy" integer,
  "notes" text,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" serial PRIMARY KEY NOT NULL,
  "jti" varchar(64) NOT NULL,
  "userId" integer NOT NULL,
  "revokedAt" timestamp,
  "expiresAt" timestamp NOT NULL,
  "ip" varchar(45),
  "userAgent" varchar(256),
  "createdAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "sessions_jti_unique" UNIQUE("jti")
);

CREATE TABLE IF NOT EXISTS "consents" (
  "id" serial PRIMARY KEY NOT NULL,
  "userId" integer NOT NULL,
  "type" "consent_type" NOT NULL,
  "version" varchar(32) NOT NULL,
  "granted" boolean DEFAULT true NOT NULL,
  "ip" varchar(45),
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "refunds" (
  "id" serial PRIMARY KEY NOT NULL,
  "refundRef" varchar(32) NOT NULL,
  "walletId" integer NOT NULL,
  "transactionId" integer,
  "amountKobo" bigint NOT NULL,
  "reason" text NOT NULL,
  "status" "refund_status" DEFAULT 'pending' NOT NULL,
  "requestedBy" integer NOT NULL,
  "approvedBy" integer,
  "providerRef" varchar(128),
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "refunds_refundRef_unique" UNIQUE("refundRef")
);

CREATE TABLE IF NOT EXISTS "disputes" (
  "id" serial PRIMARY KEY NOT NULL,
  "disputeRef" varchar(128) NOT NULL,
  "provider" varchar(32) NOT NULL,
  "paymentRef" varchar(128) NOT NULL,
  "walletId" integer,
  "amountKobo" bigint,
  "fundsFrozen" boolean DEFAULT true NOT NULL,
  "status" varchar(32) DEFAULT 'open' NOT NULL,
  "rawPayload" jsonb,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "resolvedAt" timestamp,
  CONSTRAINT "disputes_disputeRef_unique" UNIQUE("disputeRef")
);

CREATE TABLE IF NOT EXISTS "fraud_labels" (
  "id" serial PRIMARY KEY NOT NULL,
  "entityType" varchar(32) NOT NULL,
  "entityId" varchar(128) NOT NULL,
  "label" varchar(64) NOT NULL,
  "score" integer,
  "createdBy" integer,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "agents" (
  "id" serial PRIMARY KEY NOT NULL,
  "userId" integer NOT NULL,
  "agentCode" varchar(32) NOT NULL,
  "region" varchar(64),
  "status" "agent_status" DEFAULT 'active' NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "agents_userId_unique" UNIQUE("userId"),
  CONSTRAINT "agents_agentCode_unique" UNIQUE("agentCode")
);

-- ── Column additions for existing deployments ───────────────────────────────
ALTER TABLE "kyc_applications" ADD COLUMN IF NOT EXISTS "draftId" varchar(64);
ALTER TABLE "ussd_sessions" ADD COLUMN IF NOT EXISTS "state" jsonb;
ALTER TABLE "ussd_sessions" ADD COLUMN IF NOT EXISTS "lastActivityAt" timestamp DEFAULT now() NOT NULL;

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "idx_kyc_userId" ON "kyc_applications" ("userId");
CREATE INDEX IF NOT EXISTS "idx_kyc_status" ON "kyc_applications" ("status");
CREATE INDEX IF NOT EXISTS "idx_kyc_type" ON "kyc_applications" ("type");
CREATE INDEX IF NOT EXISTS "idx_wallet_userId" ON "wallet_accounts" ("userId");
CREATE INDEX IF NOT EXISTS "idx_wtx_walletId" ON "wallet_transactions" ("walletId");
CREATE INDEX IF NOT EXISTS "idx_wtx_type" ON "wallet_transactions" ("type");
CREATE INDEX IF NOT EXISTS "idx_wtx_createdAt" ON "wallet_transactions" ("createdAt");
CREATE INDEX IF NOT EXISTS "idx_sq_status" ON "sync_queue" ("status");
CREATE INDEX IF NOT EXISTS "idx_sq_userId" ON "sync_queue" ("userId");
CREATE INDEX IF NOT EXISTS "idx_otp_phone" ON "otp_codes" ("phone");
CREATE INDEX IF NOT EXISTS "idx_otp_expiresAt" ON "otp_codes" ("expiresAt");
CREATE INDEX IF NOT EXISTS "idx_recon_startedAt" ON "reconciliation_runs" ("startedAt");
CREATE INDEX IF NOT EXISTS "idx_recon_status" ON "reconciliation_runs" ("status");
CREATE INDEX IF NOT EXISTS "idx_recon_resolvedAt" ON "reconciliation_runs" ("resolvedAt");
CREATE INDEX IF NOT EXISTS "idx_nfc_batch_submittedBy" ON "nfc_batch_jobs" ("submittedBy");
CREATE INDEX IF NOT EXISTS "idx_nfc_batch_status" ON "nfc_batch_jobs" ("status");
CREATE INDEX IF NOT EXISTS "idx_nfc_batch_createdAt" ON "nfc_batch_jobs" ("createdAt");
CREATE INDEX IF NOT EXISTS "idx_device_serial" ON "toll_devices" ("serial");
CREATE INDEX IF NOT EXISTS "idx_device_plaza" ON "toll_devices" ("plaza");
CREATE INDEX IF NOT EXISTS "idx_device_status" ON "toll_devices" ("status");
CREATE INDEX IF NOT EXISTS "idx_dal_deviceId" ON "device_alert_logs" ("deviceId");
CREATE INDEX IF NOT EXISTS "idx_dal_serial" ON "device_alert_logs" ("serial");
CREATE INDEX IF NOT EXISTS "idx_dal_resolvedAt" ON "device_alert_logs" ("resolvedAt");
CREATE INDEX IF NOT EXISTS "idx_ussd_sessionId" ON "ussd_sessions" ("sessionId");
CREATE INDEX IF NOT EXISTS "idx_ussd_phoneNumber" ON "ussd_sessions" ("phoneNumber");
CREATE INDEX IF NOT EXISTS "idx_ussd_startedAt" ON "ussd_sessions" ("startedAt");
CREATE INDEX IF NOT EXISTS "idx_ussd_completed" ON "ussd_sessions" ("completed");
CREATE INDEX IF NOT EXISTS "idx_qr_scan_deviceSerial" ON "qr_scan_logs" ("deviceSerial");
CREATE INDEX IF NOT EXISTS "idx_qr_scan_valid" ON "qr_scan_logs" ("valid");
CREATE INDEX IF NOT EXISTS "idx_qr_scan_scannedAt" ON "qr_scan_logs" ("scannedAt");
CREATE INDEX IF NOT EXISTS "idx_qr_scan_operatorUserId" ON "qr_scan_logs" ("operatorUserId");
CREATE INDEX IF NOT EXISTS "idx_nfc_prov_tagId" ON "nfc_provisioning_events" ("tagId");
CREATE INDEX IF NOT EXISTS "idx_nfc_prov_provisionedBy" ON "nfc_provisioning_events" ("provisionedBy");
CREATE INDEX IF NOT EXISTS "idx_nfc_prov_createdAt" ON "nfc_provisioning_events" ("createdAt");
CREATE INDEX IF NOT EXISTS "idx_audit_actor" ON "audit_logs" ("actorUserId");
CREATE INDEX IF NOT EXISTS "idx_audit_entity" ON "audit_logs" ("entity", "entityId");
CREATE INDEX IF NOT EXISTS "idx_audit_createdAt" ON "audit_logs" ("createdAt");
CREATE INDEX IF NOT EXISTS "idx_ksh_referenceId" ON "kyc_status_history" ("referenceId");
CREATE INDEX IF NOT EXISTS "idx_ksh_createdAt" ON "kyc_status_history" ("createdAt");
CREATE INDEX IF NOT EXISTS "idx_sessions_userId" ON "sessions" ("userId");
CREATE INDEX IF NOT EXISTS "idx_sessions_expiresAt" ON "sessions" ("expiresAt");
CREATE INDEX IF NOT EXISTS "idx_consents_userId" ON "consents" ("userId");
CREATE INDEX IF NOT EXISTS "idx_consents_type" ON "consents" ("type");
CREATE INDEX IF NOT EXISTS "idx_refunds_walletId" ON "refunds" ("walletId");
CREATE INDEX IF NOT EXISTS "idx_refunds_status" ON "refunds" ("status");
CREATE INDEX IF NOT EXISTS "idx_disputes_paymentRef" ON "disputes" ("paymentRef");
CREATE INDEX IF NOT EXISTS "idx_disputes_walletId" ON "disputes" ("walletId");
CREATE INDEX IF NOT EXISTS "idx_fraud_entity" ON "fraud_labels" ("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "idx_agents_status" ON "agents" ("status");

-- ── Uniqueness + integrity constraints ──────────────────────────────────────
-- Idempotency: one credited ledger row per external payment reference (P0-4).
CREATE UNIQUE INDEX IF NOT EXISTS "uq_wtx_externalRef"
  ON "wallet_transactions" ("externalRef") WHERE "externalRef" IS NOT NULL;

-- Offline-draft idempotency: one application per (user, type, draftId) (P1-13).
CREATE UNIQUE INDEX IF NOT EXISTS "uq_kyc_user_type_draft"
  ON "kyc_applications" ("userId", "type", "draftId") WHERE "draftId" IS NOT NULL;

-- Balance can never go negative at the DB level (P0-4 / P1-22).
DO $$ BEGIN
  ALTER TABLE "wallet_accounts"
    ADD CONSTRAINT "ck_wallet_balance_nonnegative" CHECK ("balanceKobo" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "wallet_accounts"
    ADD CONSTRAINT "ck_wallet_daily_spent_nonnegative" CHECK ("dailySpentKobo" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Foreign keys ────────────────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "kyc_applications"
    ADD CONSTRAINT "fk_kyc_user" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "wallet_transactions"
    ADD CONSTRAINT "fk_wtx_wallet" FOREIGN KEY ("walletId")
    REFERENCES "wallet_accounts"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "device_alert_logs"
    ADD CONSTRAINT "fk_dal_device" FOREIGN KEY ("deviceId")
    REFERENCES "toll_devices"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "wallet_accounts"
    ADD CONSTRAINT "fk_wallet_user" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "sessions"
    ADD CONSTRAINT "fk_sessions_user" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "consents"
    ADD CONSTRAINT "fk_consents_user" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "refunds"
    ADD CONSTRAINT "fk_refunds_wallet" FOREIGN KEY ("walletId")
    REFERENCES "wallet_accounts"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "agents"
    ADD CONSTRAINT "fk_agents_user" FOREIGN KEY ("userId")
    REFERENCES "users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ANALYZE;
