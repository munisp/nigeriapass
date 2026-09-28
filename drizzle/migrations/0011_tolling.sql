-- =============================================================================
-- 0011_tolling.sql
-- =============================================================================
-- eTag + RFID lane middleware and POS tables (tolling v14).
--
-- Covers:
--   * New enums: tag_type, tag_status, lane_direction, charge_status,
--     pos_vendor, terminal_status, pos_txn_type, pos_txn_status
--   * New tables: rfid_tags, lane_events, pos_terminals, pos_transactions
--   * FKs: rfid_tags.walletId → wallet_accounts, rfid_tags.issuedBy → users,
--     lane_events.deviceId → toll_devices, pos_transactions.terminalId →
--     pos_terminals
--   * Indexes matching drizzle/schema.ts
--
-- Idempotent: safe to run multiple times. Apply with:
--   psql "$DATABASE_URL" -f drizzle/migrations/0011_tolling.sql
-- NOTE: drizzle/meta journal is NOT machine-generated for this file
-- (hand-written, consistent with 0009/0010). See drizzle/migrations/README.md.
-- =============================================================================

-- ── Enums (guarded) ─────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "public"."tag_type" AS ENUM('rfid_windshield', 'etag', 'nfc_card');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "public"."tag_status" AS ENUM('issued', 'active', 'suspended', 'lost', 'replaced', 'decommissioned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "public"."lane_direction" AS ENUM('entry', 'exit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "public"."charge_status" AS ENUM('charged', 'insufficient', 'free', 'exempt', 'queued', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "public"."pos_vendor" AS ENUM('paystack', 'flutterwave', 'interswitch', 'moniepoint');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "public"."terminal_status" AS ENUM('active', 'inactive', 'maintenance', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "public"."pos_txn_type" AS ENUM('toll_payment', 'wallet_topup');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "public"."pos_txn_status" AS ENUM('pending', 'approved', 'declined', 'reversed', 'queued_offline');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── rfid_tags ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "rfid_tags" (
  "id" serial PRIMARY KEY NOT NULL,
  "tagEpc" text NOT NULL,
  "tagType" "tag_type" NOT NULL,
  "vehiclePlate" text,
  "kycApplicationId" integer,
  "walletId" integer,
  "status" "tag_status" DEFAULT 'issued' NOT NULL,
  "issuedBy" integer,
  "issuedAt" timestamp DEFAULT now() NOT NULL,
  "activatedAt" timestamp,
  "replacedByTagId" integer,
  "meta" jsonb,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "rfid_tags_tagEpc_unique" UNIQUE("tagEpc")
);

CREATE INDEX IF NOT EXISTS "idx_rfid_tags_vehiclePlate" ON "rfid_tags" ("vehiclePlate");
CREATE INDEX IF NOT EXISTS "idx_rfid_tags_walletId" ON "rfid_tags" ("walletId");
CREATE INDEX IF NOT EXISTS "idx_rfid_tags_status" ON "rfid_tags" ("status");

DO $$ BEGIN
  ALTER TABLE "rfid_tags"
    ADD CONSTRAINT "rfid_tags_walletId_wallet_accounts_id_fk"
    FOREIGN KEY ("walletId") REFERENCES "public"."wallet_accounts"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "rfid_tags"
    ADD CONSTRAINT "rfid_tags_issuedBy_users_id_fk"
    FOREIGN KEY ("issuedBy") REFERENCES "public"."users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── lane_events ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "lane_events" (
  "id" serial PRIMARY KEY NOT NULL,
  "eventUid" text NOT NULL,
  "plazaId" text NOT NULL,
  "laneId" text NOT NULL,
  "readerId" text,
  "deviceId" integer,
  "tagEpc" text NOT NULL,
  "walletId" integer,
  "direction" "lane_direction" DEFAULT 'exit' NOT NULL,
  "amountKobo" integer NOT NULL,
  "chargeStatus" "charge_status" NOT NULL,
  "walletTxnId" integer,
  "fraudScore" real,
  "antiPassbackBlocked" boolean DEFAULT false NOT NULL,
  "occurredAt" timestamp NOT NULL,
  "receivedAt" timestamp DEFAULT now() NOT NULL,
  "rawPayload" jsonb,
  CONSTRAINT "lane_events_eventUid_unique" UNIQUE("eventUid")
);

CREATE INDEX IF NOT EXISTS "idx_lane_events_plaza_occurred" ON "lane_events" ("plazaId", "occurredAt");
CREATE INDEX IF NOT EXISTS "idx_lane_events_tag_occurred" ON "lane_events" ("tagEpc", "occurredAt");
CREATE INDEX IF NOT EXISTS "idx_lane_events_chargeStatus" ON "lane_events" ("chargeStatus");

DO $$ BEGIN
  ALTER TABLE "lane_events"
    ADD CONSTRAINT "lane_events_deviceId_toll_devices_id_fk"
    FOREIGN KEY ("deviceId") REFERENCES "public"."toll_devices"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── pos_terminals ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "pos_terminals" (
  "id" serial PRIMARY KEY NOT NULL,
  "terminalId" text NOT NULL,
  "plazaId" text NOT NULL,
  "vendor" "pos_vendor" NOT NULL,
  "serialNumber" text,
  "status" "terminal_status" DEFAULT 'active' NOT NULL,
  "registeredBy" integer,
  "lastSeenAt" timestamp,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "pos_terminals_terminalId_unique" UNIQUE("terminalId")
);

CREATE INDEX IF NOT EXISTS "idx_pos_terminals_plazaId" ON "pos_terminals" ("plazaId");
CREATE INDEX IF NOT EXISTS "idx_pos_terminals_status" ON "pos_terminals" ("status");

-- ── pos_transactions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "pos_transactions" (
  "id" serial PRIMARY KEY NOT NULL,
  "txnUid" text NOT NULL,
  "terminalId" integer NOT NULL,
  "type" "pos_txn_type" NOT NULL,
  "amountKobo" integer NOT NULL,
  "cardLast4" text,
  "cardScheme" text,
  "rrn" text,
  "stan" text,
  "status" "pos_txn_status" DEFAULT 'pending' NOT NULL,
  "walletId" integer,
  "laneEventId" integer,
  "occurredAt" timestamp NOT NULL,
  "syncedAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "pos_transactions_txnUid_unique" UNIQUE("txnUid")
);

CREATE INDEX IF NOT EXISTS "idx_pos_txn_terminal_occurred" ON "pos_transactions" ("terminalId", "occurredAt");
CREATE INDEX IF NOT EXISTS "idx_pos_txn_walletId" ON "pos_transactions" ("walletId");
CREATE INDEX IF NOT EXISTS "idx_pos_txn_status" ON "pos_transactions" ("status");

DO $$ BEGIN
  ALTER TABLE "pos_transactions"
    ADD CONSTRAINT "pos_transactions_terminalId_pos_terminals_id_fk"
    FOREIGN KEY ("terminalId") REFERENCES "public"."pos_terminals"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
