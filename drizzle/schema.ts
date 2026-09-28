import {
  pgTable, pgEnum, serial, text, varchar, integer, bigint, real,
  boolean, jsonb, timestamp, index, unique,
} from "drizzle-orm/pg-core";

// ── Enums ─────────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", [
  "user",
  "admin",
  "agent",
  "operator",
  "reviewer",
  "support",
  "installer",
]);
export const kycTypeEnum = pgEnum("kyc_type", ["driver", "vehicle", "fleet"]);
export const kycStatusEnum = pgEnum("kyc_status", [
  "draft",
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "requires_resubmission",
]);
export const txTypeEnum = pgEnum("tx_type", ["topup", "toll_charge", "refund", "adjustment"]);
export const reconcileStatusEnum = pgEnum("reconcile_status", ["success", "partial", "failed", "empty"]);
export const syncStatusEnum = pgEnum("sync_status", ["pending", "processing", "done", "failed"]);

// ── Users ─────────────────────────────────────────────────────────────────────

/**
 * Core user table backing auth flow.
 */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: userRoleEnum("role").default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ── KYC Applications ──────────────────────────────────────────────────────────

/**
 * KYC/KYB application submissions.
 * Stores all onboarding form data submitted by drivers, vehicle owners, and fleet operators.
 */
export const kycApplications = pgTable("kyc_applications", {
  id: serial("id").primaryKey(),
  /** Stable reference ID shown to users (e.g. DRV-XKQP7) */
  referenceId: varchar("referenceId", { length: 32 }).notNull().unique(),
  /** FK to users.id — null for anonymous/offline submissions until user is identified */
  userId: integer("userId"),
  /** Application type */
  type: kycTypeEnum("type").notNull(),
  /** Current review status */
  status: kycStatusEnum("status").default("draft").notNull(),
  /** Full form data as JSONB (NIN, BVN, documents, vehicle details, etc.) */
  formData: jsonb("formData").notNull(),
  /** KYC score computed server-side (0-100) */
  kycScore: integer("kycScore"),
  /** Admin notes on the application */
  reviewNotes: text("reviewNotes"),
  /** ID of the admin user who reviewed this */
  reviewedBy: integer("reviewedBy"),
  /** When the admin completed the review */
  reviewedAt: timestamp("reviewedAt"),
  /** Whether this was submitted from an offline queue replay */
  fromOfflineQueue: boolean("fromOfflineQueue").default(false).notNull(),
  /** Client-side draft version at time of submission */
  clientVersion: integer("clientVersion").default(1).notNull(),
  /** Client-generated draft ID for offline-queue idempotency (unique per user+type) */
  draftId: varchar("draftId", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (table) => [
  index("idx_kyc_userId").on(table.userId),
  index("idx_kyc_status").on(table.status),
  index("idx_kyc_type").on(table.type),
  // Idempotency for offline draft replay: one application per (user, type, draftId)
  unique("uq_kyc_user_type_draft").on(table.userId, table.type, table.draftId),
]);

export type KycApplication = typeof kycApplications.$inferSelect;
export type InsertKycApplication = typeof kycApplications.$inferInsert;

// ── Wallet Accounts ───────────────────────────────────────────────────────────

/**
 * Toll wallet accounts backed by TigerBeetle ledger IDs.
 * One account per user. Balance is authoritative in TigerBeetle;
 * this table stores the mapping and cached balance for fast reads.
 */
export const walletAccounts = pgTable("wallet_accounts", {
  id: serial("id").primaryKey(),
  userId: integer("userId").notNull().unique(),
  /** TigerBeetle account ID (128-bit, stored as string) */
  tigerBeetleId: varchar("tigerBeetleId", { length: 40 }).notNull().unique(),
  /** Cached balance in kobo (₦1 = 100 kobo). Refreshed on every transaction. */
  balanceKobo: bigint("balanceKobo", { mode: "number" }).default(0).notNull(),
  /** Daily fare cap in kobo */
  dailyCapKobo: bigint("dailyCapKobo", { mode: "number" }).default(500000).notNull(),
  /** Amount spent today in kobo — reset at midnight WAT */
  dailySpentKobo: bigint("dailySpentKobo", { mode: "number" }).default(0).notNull(),
  lastBalanceSync: timestamp("lastBalanceSync").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (table) => [
  index("idx_wallet_userId").on(table.userId),
]);

export type WalletAccount = typeof walletAccounts.$inferSelect;
export type InsertWalletAccount = typeof walletAccounts.$inferInsert;

// ── Wallet Transactions ───────────────────────────────────────────────────────

/**
 * Immutable ledger of all wallet transactions (top-ups, toll charges, refunds).
 */
export const walletTransactions = pgTable("wallet_transactions", {
  id: serial("id").primaryKey(),
  walletId: integer("walletId").notNull(),
  type: txTypeEnum("type").notNull(),
  /** Amount in kobo — always positive; direction determined by type */
  amountKobo: bigint("amountKobo", { mode: "number" }).notNull(),
  /** Balance after this transaction in kobo */
  balanceAfterKobo: bigint("balanceAfterKobo", { mode: "number" }).notNull(),
  description: text("description"),
  /** External payment reference (Paystack/Flutterwave) */
  externalRef: varchar("externalRef", { length: 128 }),
  /** Toll plaza ID for toll_charge transactions */
  plazaId: varchar("plazaId", { length: 32 }),
  /** TigerBeetle transfer ID */
  tigerBeetleTransferId: varchar("tigerBeetleTransferId", { length: 40 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_wtx_walletId").on(table.walletId),
  index("idx_wtx_type").on(table.type),
  index("idx_wtx_createdAt").on(table.createdAt),
  // Idempotency guard: an external payment reference may only be credited once
  unique("uq_wtx_externalRef").on(table.externalRef),
]);

export type WalletTransaction = typeof walletTransactions.$inferSelect;
export type InsertWalletTransaction = typeof walletTransactions.$inferInsert;

// ── Background Sync Queue ─────────────────────────────────────────────────────

/**
 * Server-side mirror of the client's IndexedDB retry queue.
 */
export const syncQueue = pgTable("sync_queue", {
  id: serial("id").primaryKey(),
  /** Client-generated UUID matching the IndexedDB item id */
  clientId: varchar("clientId", { length: 64 }).notNull().unique(),
  userId: integer("userId"),
  /** The tRPC procedure path that was queued (e.g. "kyc.submitDriver") */
  procedure: varchar("procedure", { length: 128 }).notNull(),
  /** Serialised input payload */
  payload: jsonb("payload").notNull(),
  status: syncStatusEnum("status").default("pending").notNull(),
  /** Number of processing attempts */
  attempts: integer("attempts").default(0).notNull(),
  /** Error message from the last failed attempt */
  lastError: text("lastError"),
  /** When the item was originally queued on the client */
  queuedAt: timestamp("queuedAt").notNull(),
  processedAt: timestamp("processedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (table) => [
  index("idx_sq_status").on(table.status),
  index("idx_sq_userId").on(table.userId),
]);

export type SyncQueueItem = typeof syncQueue.$inferSelect;
export type InsertSyncQueueItem = typeof syncQueue.$inferInsert;

// ── OTP Codes ─────────────────────────────────────────────────────────────────

/**
 * Short-lived SMS OTP codes for phone-number login.
 * Codes are 6 digits, expire after 2 minutes, and are single-use.
 */
export const otpCodes = pgTable("otp_codes", {
  id: serial("id").primaryKey(),
  /** E.164 phone number (e.g. +2348012345678) */
  phone: varchar("phone", { length: 20 }).notNull(),
  /** 6-digit code (hashed with bcrypt in production) */
  codeHash: varchar("codeHash", { length: 128 }).notNull(),
  /** Whether this code has already been used */
  used: boolean("used").default(false).notNull(),
  /** Number of failed verification attempts (max 5 before lockout) */
  attempts: integer("attempts").default(0).notNull(),
  /** IP address of the requester for rate-limit audit */
  requestIp: varchar("requestIp", { length: 45 }),
  /** Africa's Talking message ID for delivery tracking */
  messageId: varchar("messageId", { length: 64 }),
  /** When the code expires (2 minutes from creation) */
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_otp_phone").on(table.phone),
  index("idx_otp_expiresAt").on(table.expiresAt),
]);

export type OtpCode = typeof otpCodes.$inferSelect;
export type InsertOtpCode = typeof otpCodes.$inferInsert;

// ── Reconciliation Runs ────────────────────────────────────────────────────────────

/**
 * Persistent log of every reconciliation run (manual + scheduled).
 * Used by the Admin Reconciliation page to show server-side history.
 */
export const reconciliationRuns = pgTable("reconciliation_runs", {
  id: serial("id").primaryKey(),
  /** 'manual' = triggered by admin, 'scheduled' = nightly cron */
  triggeredBy: varchar("triggeredBy", { length: 16 }).notNull().default("scheduled"),
  /** Overall run outcome */
  status: reconcileStatusEnum("status").notNull(),
  /** Number of pending transactions found */
  processed: integer("processed").notNull().default(0),
  /** Number of transactions successfully credited */
  credited: integer("credited").notNull().default(0),
  /** Number of transactions that failed */
  failed: integer("failed").notNull().default(0),
  /** Number of transactions skipped (not yet successful at provider) */
  skipped: integer("skipped").notNull().default(0),
  /** JSON array of error messages */
  errors: jsonb("errors").$type<string[]>().notNull().default([]),
  /** Wall-clock duration of the run in milliseconds */
  durationMs: integer("durationMs").notNull().default(0),
  /** ID of the admin user who triggered a manual run (null for scheduled) */
  triggeredByUserId: integer("triggeredByUserId"),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  /** Set when an admin marks this alert as investigated/resolved */
  resolvedAt: timestamp("resolvedAt"),
  /** Optional note left by the admin when resolving the alert */
  resolvedNote: varchar("resolvedNote", { length: 500 }),
}, (table) => [
  index("idx_recon_startedAt").on(table.startedAt),
  index("idx_recon_status").on(table.status),
  index("idx_recon_resolvedAt").on(table.resolvedAt),
]);

export type ReconciliationRun = typeof reconciliationRuns.$inferSelect;
export type InsertReconciliationRun = typeof reconciliationRuns.$inferInsert;

// ── NFC Batch Provisioning Jobs ───────────────────────────────────────────────
/**
 * Tracks bulk NFC tag provisioning jobs submitted by operators.
 * Each job contains a list of tag IDs and their derived keys.
 * The full key material is never stored — only metadata for audit.
 */
export const nfcBatchJobStatusEnum = pgEnum("nfc_batch_job_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

export const nfcBatchJobs = pgTable("nfc_batch_jobs", {
  id: serial("id").primaryKey(),
  /** Human-readable job reference (e.g. BATCH-XKQP7) */
  jobRef: varchar("jobRef", { length: 32 }).notNull().unique(),
  /** ID of the admin user who submitted the batch */
  submittedBy: integer("submittedBy").notNull(),
  /** Total number of tag IDs in the batch */
  totalTags: integer("totalTags").notNull(),
  /** Number of tags successfully provisioned */
  provisioned: integer("provisioned").notNull().default(0),
  /** Number of tags that failed */
  failed: integer("failed").notNull().default(0),
  /** Current job status */
  status: nfcBatchJobStatusEnum("status").notNull().default("pending"),
  /** JSON array of per-tag results (tagId, vehicleRef, refId, keyHexPrefix, error?) */
  results: jsonb("results").$type<Array<{
    tagId: string;
    vehicleRef: string;
    refId?: string;
    keyHexPrefix?: string;
    error?: string;
  }>>().notNull().default([]),
  /** Error message if the entire job failed */
  errorMessage: text("errorMessage"),
  /** Wall-clock duration in milliseconds */
  durationMs: integer("durationMs").notNull().default(0),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_nfc_batch_submittedBy").on(table.submittedBy),
  index("idx_nfc_batch_status").on(table.status),
  index("idx_nfc_batch_createdAt").on(table.createdAt),
]);

export type NfcBatchJob = typeof nfcBatchJobs.$inferSelect;
export type InsertNfcBatchJob = typeof nfcBatchJobs.$inferInsert;

// ── Toll Devices ──────────────────────────────────────────────────────────────
/**
 * Physical toll-plaza hardware devices (NFC readers, barriers, cameras, etc.)
 * Managed by admin users; heartbeat data is overlaid from the WebSocket service.
 */
export const deviceTypeEnum = pgEnum("device_type", [
  "nfc_reader",
  "barrier",
  "camera",
  "display",
  "edge_unit",
]);

export const deviceStatusEnum = pgEnum("device_status", [
  "online",
  "offline",
  "warning",
  "maintenance",
  "lost",
  "stolen",
  "decommissioned",
]);

export const tollDevices = pgTable("toll_devices", {
  id: serial("id").primaryKey(),
  /** Hardware serial number — unique per device */
  serial: varchar("serial", { length: 64 }).notNull().unique(),
  /** Human-readable name */
  name: varchar("name", { length: 128 }).notNull(),
  type: deviceTypeEnum("type").notNull(),
  /** Plaza name (e.g. "Lagos-Ibadan Toll") */
  plaza: varchar("plaza", { length: 128 }).notNull(),
  /** Lane identifier (e.g. "Lane 1", "All Lanes") */
  lane: varchar("lane", { length: 64 }).notNull(),
  status: deviceStatusEnum("status").notNull().default("offline"),
  /** Installed firmware version */
  firmware: varchar("firmware", { length: 32 }).notNull().default("1.0.0"),
  /** Latest available firmware version */
  latestFirmware: varchar("latestFirmware", { length: 32 }).notNull().default("1.0.0"),
  /** Uptime string (e.g. "14d 6h") — updated by heartbeat */
  uptime: varchar("uptime", { length: 32 }).notNull().default("0d 0h"),
  /** CPU usage % (0-100) — updated by heartbeat */
  cpu: integer("cpu").notNull().default(0),
  /** Memory usage % (0-100) — updated by heartbeat */
  memory: integer("memory").notNull().default(0),
  /** Temperature in Celsius — updated by heartbeat */
  temp: integer("temp").notNull().default(0),
  /** Active alert count */
  alerts: integer("alerts").notNull().default(0),
  lastSeen: timestamp("lastSeen").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (table) => [
  index("idx_device_serial").on(table.serial),
  index("idx_device_plaza").on(table.plaza),
  index("idx_device_status").on(table.status),
]);

export type TollDevice = typeof tollDevices.$inferSelect;
export type InsertTollDevice = typeof tollDevices.$inferInsert;

// ── Device Alert Logs ─────────────────────────────────────────────────────────
/**
 * Immutable audit log of every alert resolution event on a toll device.
 * Written by resolveAlert; read by getAlertHistory.
 */
export const deviceAlertLogs = pgTable("device_alert_logs", {
  id: serial("id").primaryKey(),
  /** FK to toll_devices.id */
  deviceId: integer("deviceId").notNull(),
  /** Serial number of the device at time of resolution (denormalised for fast reads) */
  serial: varchar("serial", { length: 64 }).notNull(),
  /** Plaza name at time of resolution */
  plaza: varchar("plaza", { length: 128 }).notNull(),
  /** Number of alerts that were cleared */
  alertsCleared: integer("alertsCleared").notNull().default(0),
  /** Optional resolution note left by the admin */
  note: text("note"),
  /** ID of the admin user who resolved the alert */
  resolvedByUserId: integer("resolvedByUserId").notNull(),
  /** Name of the admin user (denormalised for display) */
  resolvedByName: varchar("resolvedByName", { length: 128 }),
  resolvedAt: timestamp("resolvedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_dal_deviceId").on(table.deviceId),
  index("idx_dal_serial").on(table.serial),
  index("idx_dal_resolvedAt").on(table.resolvedAt),
]);

export type DeviceAlertLog = typeof deviceAlertLogs.$inferSelect;
export type InsertDeviceAlertLog = typeof deviceAlertLogs.$inferInsert;

// ── USSD Sessions ─────────────────────────────────────────────────────────────
/**
 * Persisted USSD session records for analytics.
 * Written by the USSD route handler on session end; read by ussd.getSessionStats.
 */
export const ussdSessions = pgTable("ussd_sessions", {
  id: serial("id").primaryKey(),
  /** Africa's Talking session ID */
  sessionId: varchar("sessionId", { length: 128 }).notNull().unique(),
  /** Caller phone number */
  phoneNumber: varchar("phoneNumber", { length: 32 }).notNull(),
  /** Service code dialled */
  serviceCode: varchar("serviceCode", { length: 32 }),
  /** Final menu path taken (pipe-separated menu levels, e.g. "1|2|1") */
  menuPath: text("menuPath"),
  /** Whether the session completed successfully (CON → END reached) */
  completed: boolean("completed").notNull().default(false),
  /** Total number of menu interactions in the session */
  interactionCount: integer("interactionCount").notNull().default(0),
  /** Duration in seconds (null if session abandoned) */
  durationSeconds: integer("durationSeconds"),
  /** ISO country code derived from phone number */
  countryCode: varchar("countryCode", { length: 4 }),
  /** Live session state for multi-instance USSD handling (screen, inputs, etc.) */
  state: jsonb("state").$type<Record<string, unknown>>(),
  /** Last interaction time — used for TTL sweeps */
  lastActivityAt: timestamp("lastActivityAt").defaultNow().notNull(),
  startedAt: timestamp("startedAt").defaultNow().notNull(),
  endedAt: timestamp("endedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_ussd_sessionId").on(table.sessionId),
  index("idx_ussd_phoneNumber").on(table.phoneNumber),
  index("idx_ussd_startedAt").on(table.startedAt),
  index("idx_ussd_completed").on(table.completed),
]);
export type UssdSession = typeof ussdSessions.$inferSelect;
export type InsertUssdSession = typeof ussdSessions.$inferInsert;

// ── QR Scan Audit Log ─────────────────────────────────────────────────────────
/**
 * Persists every validateQrCode call for security auditing.
 * Allows security officers to review all gate access attempts.
 */
export const qrScanLogs = pgTable("qr_scan_logs", {
  id: serial("id").primaryKey(),
  /** Device serial number from the scanned QR URI */
  deviceSerial: varchar("deviceSerial", { length: 64 }).notNull(),
  /** Full scanned URI (nigerianpass://station/...) */
  scannedUri: text("scannedUri").notNull(),
  /** Whether the QR was valid (signature OK and not expired) */
  valid: boolean("valid").notNull(),
  /** Reason for rejection (e.g. "expired", "invalid_signature", "device_not_found") */
  rejectionReason: varchar("rejectionReason", { length: 128 }),
  /** Plaza name from the device record at scan time */
  plazaName: varchar("plazaName", { length: 128 }),
  /** Lane identifier from the device record */
  lane: varchar("lane", { length: 32 }),
  /** Operator user ID (null for unauthenticated/gate-controller scans) */
  operatorUserId: integer("operatorUserId"),
  /** Operator display name */
  operatorName: varchar("operatorName", { length: 128 }),
  scannedAt: timestamp("scannedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_qr_scan_deviceSerial").on(table.deviceSerial),
  index("idx_qr_scan_valid").on(table.valid),
  index("idx_qr_scan_scannedAt").on(table.scannedAt),
  index("idx_qr_scan_operatorUserId").on(table.operatorUserId),
]);
export type QrScanLog = typeof qrScanLogs.$inferSelect;
export type InsertQrScanLog = typeof qrScanLogs.$inferInsert;

// ── NFC Provisioning Events ───────────────────────────────────────────────────
/**
 * Immutable audit trail for NFC tag provisioning.
 * Replaces the legacy abuse of kyc_applications as an NFC audit log.
 * The full derived key is NEVER stored — only an 8-char prefix.
 */
export const nfcProvisioningEvents = pgTable("nfc_provisioning_events", {
  id: serial("id").primaryKey(),
  /** Human-readable event reference (e.g. NFC-ABCD1234-LXYZ) */
  refId: varchar("refId", { length: 48 }).notNull().unique(),
  tagId: varchar("tagId", { length: 64 }).notNull(),
  vehicleRef: varchar("vehicleRef", { length: 64 }).notNull(),
  /** First 8 hex chars of the derived key + "..." — never the full key */
  keyHexPrefix: varchar("keyHexPrefix", { length: 16 }).notNull(),
  /** NDEF payload signature */
  signature: varchar("signature", { length: 32 }).notNull(),
  /** User who provisioned the tag */
  provisionedBy: integer("provisionedBy").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_nfc_prov_tagId").on(table.tagId),
  index("idx_nfc_prov_provisionedBy").on(table.provisionedBy),
  index("idx_nfc_prov_createdAt").on(table.createdAt),
]);
export type NfcProvisioningEvent = typeof nfcProvisioningEvents.$inferSelect;
export type InsertNfcProvisioningEvent = typeof nfcProvisioningEvents.$inferInsert;

// ── Audit Logs ────────────────────────────────────────────────────────────────
/**
 * Append-only audit trail for security-relevant administrative actions.
 */
export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  /** User performing the action (null for system jobs) */
  actorUserId: integer("actorUserId"),
  actorRole: varchar("actorRole", { length: 32 }),
  /** e.g. "kyc.approve", "wallet.credit", "nfc.provision", "refund.issue" */
  action: varchar("action", { length: 64 }).notNull(),
  /** Entity type, e.g. "kyc_application", "wallet", "nfc_tag", "user" */
  entity: varchar("entity", { length: 64 }).notNull(),
  /** Entity identifier (referenceId, wallet id, tag id, ...) */
  entityId: varchar("entityId", { length: 128 }).notNull(),
  /** Before/after diff or contextual metadata */
  diff: jsonb("diff").$type<Record<string, unknown>>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_audit_actor").on(table.actorUserId),
  index("idx_audit_entity").on(table.entity, table.entityId),
  index("idx_audit_createdAt").on(table.createdAt),
]);
export type AuditLog = typeof auditLogs.$inferSelect;
export type InsertAuditLog = typeof auditLogs.$inferInsert;

// ── KYC Status History ────────────────────────────────────────────────────────
/**
 * Immutable history of every status transition on a KYC application.
 */
export const kycStatusHistory = pgTable("kyc_status_history", {
  id: serial("id").primaryKey(),
  referenceId: varchar("referenceId", { length: 32 }).notNull(),
  fromStatus: varchar("fromStatus", { length: 32 }),
  toStatus: varchar("toStatus", { length: 32 }).notNull(),
  changedBy: integer("changedBy"),
  notes: text("notes"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_ksh_referenceId").on(table.referenceId),
  index("idx_ksh_createdAt").on(table.createdAt),
]);
export type KycStatusHistory = typeof kycStatusHistory.$inferSelect;
export type InsertKycStatusHistory = typeof kycStatusHistory.$inferInsert;

// ── Sessions (JWT revocation) ─────────────────────────────────────────────────
/**
 * Server-side session registry keyed by JWT ID (jti) for revocation support.
 */
export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  /** JWT ID claim — unique per issued token */
  jti: varchar("jti", { length: 64 }).notNull().unique(),
  userId: integer("userId").notNull(),
  /** Set when the session is revoked (logout / logoutAll / admin action) */
  revokedAt: timestamp("revokedAt"),
  expiresAt: timestamp("expiresAt").notNull(),
  ip: varchar("ip", { length: 45 }),
  userAgent: varchar("userAgent", { length: 256 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_sessions_userId").on(table.userId),
  index("idx_sessions_expiresAt").on(table.expiresAt),
]);
export type Session = typeof sessions.$inferSelect;
export type InsertSession = typeof sessions.$inferInsert;

// ── Consents (NDPR) ───────────────────────────────────────────────────────────
export const consentTypeEnum = pgEnum("consent_type", [
  "terms_of_service",
  "privacy_policy",
  "marketing",
  "data_processing",
  "location_tracking",
]);
export const consents = pgTable("consents", {
  id: serial("id").primaryKey(),
  userId: integer("userId").notNull(),
  type: consentTypeEnum("type").notNull(),
  /** Version string of the document consented to (e.g. "v1.2") */
  version: varchar("version", { length: 32 }).notNull(),
  granted: boolean("granted").notNull().default(true),
  ip: varchar("ip", { length: 45 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_consents_userId").on(table.userId),
  index("idx_consents_type").on(table.type),
]);
export type Consent = typeof consents.$inferSelect;
export type InsertConsent = typeof consents.$inferInsert;

// ── Refunds / Disputes ────────────────────────────────────────────────────────
export const refundStatusEnum = pgEnum("refund_status", [
  "pending",
  "awaiting_second_approval",
  "approved",
  "rejected",
  "processed",
  "failed",
]);
export const refunds = pgTable("refunds", {
  id: serial("id").primaryKey(),
  /** Human-readable reference (e.g. RFD-XKQP7) */
  refundRef: varchar("refundRef", { length: 32 }).notNull().unique(),
  walletId: integer("walletId").notNull(),
  /** The wallet_transactions row being refunded (if known) */
  transactionId: integer("transactionId"),
  amountKobo: bigint("amountKobo", { mode: "number" }).notNull(),
  reason: text("reason").notNull(),
  status: refundStatusEnum("status").notNull().default("pending"),
  /** Admin who requested the refund */
  requestedBy: integer("requestedBy").notNull(),
  /** Second admin who approved (4-eyes for amounts > ₦50,000) */
  approvedBy: integer("approvedBy"),
  /** Provider-side refund reference once processed */
  providerRef: varchar("providerRef", { length: 128 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (table) => [
  index("idx_refunds_walletId").on(table.walletId),
  index("idx_refunds_status").on(table.status),
]);
export type Refund = typeof refunds.$inferSelect;
export type InsertRefund = typeof refunds.$inferInsert;

export const disputes = pgTable("disputes", {
  id: serial("id").primaryKey(),
  /** Provider dispute/chargeback reference */
  disputeRef: varchar("disputeRef", { length: 128 }).notNull().unique(),
  provider: varchar("provider", { length: 32 }).notNull(),
  /** Payment reference under dispute */
  paymentRef: varchar("paymentRef", { length: 128 }).notNull(),
  walletId: integer("walletId"),
  amountKobo: bigint("amountKobo", { mode: "number" }),
  /** When true, wallet funds are frozen pending resolution */
  fundsFrozen: boolean("fundsFrozen").notNull().default(true),
  status: varchar("status", { length: 32 }).notNull().default("open"),
  rawPayload: jsonb("rawPayload").$type<Record<string, unknown>>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  resolvedAt: timestamp("resolvedAt"),
}, (table) => [
  index("idx_disputes_paymentRef").on(table.paymentRef),
  index("idx_disputes_walletId").on(table.walletId),
]);
export type Dispute = typeof disputes.$inferSelect;
export type InsertDispute = typeof disputes.$inferInsert;

// ── Fraud Labels ──────────────────────────────────────────────────────────────
export const fraudLabels = pgTable("fraud_labels", {
  id: serial("id").primaryKey(),
  /** e.g. "user", "wallet", "device", "kyc_application" */
  entityType: varchar("entityType", { length: 32 }).notNull(),
  entityId: varchar("entityId", { length: 128 }).notNull(),
  label: varchar("label", { length: 64 }).notNull(),
  /** Optional model confidence score 0–1 */
  score: integer("score"),
  createdBy: integer("createdBy"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_fraud_entity").on(table.entityType, table.entityId),
]);
export type FraudLabel = typeof fraudLabels.$inferSelect;
export type InsertFraudLabel = typeof fraudLabels.$inferInsert;

// ── Agent Registry ────────────────────────────────────────────────────────────
export const agentStatusEnum = pgEnum("agent_status", ["active", "suspended", "deactivated"]);
export const agents = pgTable("agents", {
  id: serial("id").primaryKey(),
  /** FK to users.id */
  userId: integer("userId").notNull().unique(),
  /** Public agent code (e.g. AGT-LAG-001) */
  agentCode: varchar("agentCode", { length: 32 }).notNull().unique(),
  region: varchar("region", { length: 64 }),
  status: agentStatusEnum("status").notNull().default("active"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (table) => [
  index("idx_agents_status").on(table.status),
]);
export type Agent = typeof agents.$inferSelect;
export type InsertAgent = typeof agents.$inferInsert;

// ── eTag / RFID Tags ──────────────────────────────────────────────────────────
/**
 * Registered RFID windshield tags, eTags and NFC cards used for lane tolling.
 * tagEpc is the EPC-96 identifier (24 uppercase hex chars) burned into the tag.
 * A tag is linked to a wallet (wallet_accounts.id) which is debited atomically
 * when a lane reader reports a crossing (see server/routers/lanes.ts).
 */
export const tagTypeEnum = pgEnum("tag_type", ["rfid_windshield", "etag", "nfc_card"]);
export const tagStatusEnum = pgEnum("tag_status", [
  "issued",
  "active",
  "suspended",
  "lost",
  "replaced",
  "decommissioned",
]);

export const rfidTags = pgTable("rfid_tags", {
  id: serial("id").primaryKey(),
  /** EPC-96 hex identifier, uppercase, unique per physical tag */
  tagEpc: text("tagEpc").notNull().unique(),
  tagType: tagTypeEnum("tagType").notNull(),
  /** Vehicle registration plate the tag is bound to (nullable until bound) */
  vehiclePlate: text("vehiclePlate"),
  /** KYC application that vetted the tag holder (kyc_applications.id) */
  kycApplicationId: integer("kycApplicationId"),
  /** Wallet debited on lane crossings (wallet_accounts.id) */
  walletId: integer("walletId"),
  status: tagStatusEnum("status").notNull().default("issued"),
  /** Operator user who issued the tag (users.id) */
  issuedBy: integer("issuedBy"),
  issuedAt: timestamp("issuedAt").defaultNow().notNull(),
  activatedAt: timestamp("activatedAt"),
  /** When replaced, points at the successor rfid_tags.id */
  replacedByTagId: integer("replacedByTagId"),
  /** Free-form metadata (plaza of issuance, vehicle class, exemptions, ...) */
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (table) => [
  index("idx_rfid_tags_vehiclePlate").on(table.vehiclePlate),
  index("idx_rfid_tags_walletId").on(table.walletId),
  index("idx_rfid_tags_status").on(table.status),
]);

export type RfidTag = typeof rfidTags.$inferSelect;
export type InsertRfidTag = typeof rfidTags.$inferInsert;

// ── Lane Events ───────────────────────────────────────────────────────────────
/**
 * Immutable record of every tag read reported by a lane controller.
 * eventUid is the reader-generated UUID idempotency key — replays (offline
 * store-and-forward syncs, retries) never double-charge.
 */
export const laneDirectionEnum = pgEnum("lane_direction", ["entry", "exit"]);
export const chargeStatusEnum = pgEnum("charge_status", [
  "charged",
  "insufficient",
  "free",
  "exempt",
  "queued",
  "failed",
]);

export const laneEvents = pgTable("lane_events", {
  id: serial("id").primaryKey(),
  /** Reader-generated UUID — unique idempotency key */
  eventUid: text("eventUid").notNull().unique(),
  plazaId: text("plazaId").notNull(),
  laneId: text("laneId").notNull(),
  /** Reader identifier (used for lane HMAC token derivation) */
  readerId: text("readerId"),
  /** FK to toll_devices.id when the reader is a registered device */
  deviceId: integer("deviceId"),
  tagEpc: text("tagEpc").notNull(),
  walletId: integer("walletId"),
  direction: laneDirectionEnum("direction").notNull().default("exit"),
  /** Amount that was (or would have been) charged, in kobo */
  amountKobo: integer("amountKobo").notNull(),
  chargeStatus: chargeStatusEnum("chargeStatus").notNull(),
  /** wallet_transactions.id when chargeStatus = 'charged' */
  walletTxnId: integer("walletTxnId"),
  /** Fraud probability (0-1) from the ML scoring bridge at ingest time */
  fraudScore: real("fraudScore"),
  /** True when the same tag was read at the same plaza within 5 minutes */
  antiPassbackBlocked: boolean("antiPassbackBlocked").default(false).notNull(),
  /** When the crossing physically happened (reader clock) */
  occurredAt: timestamp("occurredAt").notNull(),
  /** When the server ingested the event */
  receivedAt: timestamp("receivedAt").defaultNow().notNull(),
  /** Raw payload as received from the lane controller */
  rawPayload: jsonb("rawPayload").$type<Record<string, unknown>>(),
}, (table) => [
  index("idx_lane_events_plaza_occurred").on(table.plazaId, table.occurredAt),
  index("idx_lane_events_tag_occurred").on(table.tagEpc, table.occurredAt),
  index("idx_lane_events_chargeStatus").on(table.chargeStatus),
]);

export type LaneEvent = typeof laneEvents.$inferSelect;
export type InsertLaneEvent = typeof laneEvents.$inferInsert;

// ── POS Terminals ─────────────────────────────────────────────────────────────
/**
 * Registered point-of-sale terminals at toll plazas (Paystack, Flutterwave,
 * Interswitch, Moniepoint hardware). Populated by the pos router.
 */
export const posVendorEnum = pgEnum("pos_vendor", [
  "paystack",
  "flutterwave",
  "interswitch",
  "moniepoint",
]);
export const terminalStatusEnum = pgEnum("terminal_status", [
  "active",
  "inactive",
  "maintenance",
  "revoked",
]);

export const posTerminals = pgTable("pos_terminals", {
  id: serial("id").primaryKey(),
  /** Vendor-assigned terminal identifier — unique */
  terminalId: text("terminalId").notNull().unique(),
  plazaId: text("plazaId").notNull(),
  vendor: posVendorEnum("vendor").notNull(),
  serialNumber: text("serialNumber"),
  status: terminalStatusEnum("status").notNull().default("active"),
  /** Operator user who registered the terminal (users.id) */
  registeredBy: integer("registeredBy"),
  lastSeenAt: timestamp("lastSeenAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, (table) => [
  index("idx_pos_terminals_plazaId").on(table.plazaId),
  index("idx_pos_terminals_status").on(table.status),
]);

export type PosTerminal = typeof posTerminals.$inferSelect;
export type InsertPosTerminal = typeof posTerminals.$inferInsert;

// ── POS Transactions ──────────────────────────────────────────────────────────
/**
 * Card transactions performed on POS terminals — toll payments and wallet
 * top-ups. txnUid is the idempotency key; offline terminals queue transactions
 * (status 'queued_offline') and sync them when connectivity returns.
 */
export const posTxnTypeEnum = pgEnum("pos_txn_type", ["toll_payment", "wallet_topup"]);
export const posTxnStatusEnum = pgEnum("pos_txn_status", [
  "pending",
  "approved",
  "declined",
  "reversed",
  "queued_offline",
]);

export const posTransactions = pgTable("pos_transactions", {
  id: serial("id").primaryKey(),
  /** Terminal-generated UUID — unique idempotency key */
  txnUid: text("txnUid").notNull().unique(),
  /** FK to pos_terminals.id */
  terminalId: integer("terminalId").notNull(),
  type: posTxnTypeEnum("type").notNull(),
  amountKobo: integer("amountKobo").notNull(),
  cardLast4: text("cardLast4"),
  cardScheme: text("cardScheme"),
  /** Retrieval reference number from the card network */
  rrn: text("rrn"),
  /** System trace audit number */
  stan: text("stan"),
  status: posTxnStatusEnum("status").notNull().default("pending"),
  /** Wallet credited/debited (wallet_accounts.id) when linked */
  walletId: integer("walletId"),
  /** lane_events.id when this transaction settled a lane crossing */
  laneEventId: integer("laneEventId"),
  occurredAt: timestamp("occurredAt").notNull(),
  syncedAt: timestamp("syncedAt").defaultNow().notNull(),
}, (table) => [
  index("idx_pos_txn_terminal_occurred").on(table.terminalId, table.occurredAt),
  index("idx_pos_txn_walletId").on(table.walletId),
  index("idx_pos_txn_status").on(table.status),
]);

export type PosTransaction = typeof posTransactions.$inferSelect;
export type InsertPosTransaction = typeof posTransactions.$inferInsert;
