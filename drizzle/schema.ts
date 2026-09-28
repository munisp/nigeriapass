import {
  pgTable, pgEnum, serial, text, varchar, integer, bigint,
  boolean, jsonb, timestamp, index, unique,
} from "drizzle-orm/pg-core";

// ── Enums ─────────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", ["user", "admin"]);
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
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
}, (table) => [
  index("idx_kyc_userId").on(table.userId),
  index("idx_kyc_status").on(table.status),
  index("idx_kyc_type").on(table.type),
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
