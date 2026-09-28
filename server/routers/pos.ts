/**
 * POS Middleware Router (card-POS terminals)
 * ==========================================
 * Middleware between card-POS terminals at toll plazas and the NigerianPass
 * wallet ledger. Handles terminal lifecycle management, terminal-authenticated
 * transaction ingest (online + offline store-and-forward sync), reversals,
 * and reconciliation summaries.
 *
 * Terminal authentication (mirrors server/deviceHeartbeat.ts, audit v13 P0-9):
 *   x-terminal-token = HMAC_SHA256(POS_HMAC_SECRET, "terminal:" + terminalId)
 * The endpoint FAILS CLOSED when POS_HMAC_SECRET is unset in production;
 * outside production it falls back to the device/NFC/cookie secret chain so
 * local tooling and the Vitest suite can run.
 *
 * Money paths:
 *  - wallet_topup records credit the linked wallet via creditWalletAtomic with
 *    externalRef `POS-<txnUid>` — replays never double-credit.
 *  - Credit failures mark the POS transaction `pending` and are surfaced as
 *    errors (never silently swallowed).
 *  - Reversals post an offsetting debitWalletAtomic entry with externalRef
 *    `POS-REV-<txnUid>`; reversals > ₦50,000 require a second admin (4-eyes,
 *    following the refunds pattern in server/routers/admin.ts).
 *
 * Procedures:
 *  pos.registerTerminal     — admin: register a POS terminal
 *  pos.updateTerminal       — admin: update status/plaza
 *  pos.revokeTerminal       — admin: revoke a terminal
 *  pos.listTerminals        — admin: paginated terminal list (plaza/status/vendor filters)
 *  pos.terminalHeartbeat    — terminal-token auth: liveness ping (revoked rejected)
 *  pos.recordTransaction    — terminal-token auth: record a card transaction
 *  pos.batchSync            — terminal-token auth: offline queue sync (≤200, per-item isolation)
 *  pos.reverseTransaction   — admin: reverse an approved transaction (+ ledger reversal)
 *  pos.listTransactions     — operator/admin: paginated transaction search
 *  pos.terminalDailySummary — operator/admin: per-terminal today totals (POS-vs-ledger recon)
 */
import { z } from "zod";
import { createHmac, timingSafeEqual } from "crypto";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, gte, lt, lte } from "drizzle-orm";
import { router, publicProcedure, adminProcedure, operatorProcedure } from "../_core/trpc";
import { getDb, creditWalletAtomic, debitWalletAtomic } from "../db";
import { posTerminals, posTransactions, rfidTags, users, walletAccounts } from "../../drizzle/schema";
import { writeAuditLog } from "../_core/audit";
import { ENV } from "../_core/env";
import type { TrpcContext } from "../_core/context";
import { TOPICS, kafkaEnabled, publishEvent } from "../integrations/kafka";
import { importOptional } from "../integrations/_common";

// ── Types ─────────────────────────────────────────────────────────────────────

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
/** Minimal query surface shared by the pool db and a transaction handle. */
type DbHandle = Pick<Db, "select" | "insert" | "update" | "delete">;
type PosTerminalRow = typeof posTerminals.$inferSelect;
type PosTxnRow = typeof posTransactions.$inferSelect;
type PosTxnStatus = PosTxnRow["status"];

const POS_VENDORS = ["paystack", "flutterwave", "interswitch", "moniepoint"] as const;
const TERMINAL_STATUSES = ["active", "inactive", "maintenance", "revoked"] as const;
const TXN_STATUSES = ["pending", "approved", "declined", "reversed", "queued_offline"] as const;
const TXN_TYPES = ["toll_payment", "wallet_topup"] as const;

/** ₦50,000 — reversals above this need a second admin (4-eyes). */
const FOUR_EYES_THRESHOLD_KOBO = 50_000 * 100;
/** ₦100,000 per-transaction ceiling (100..10,000,000 kobo per the POS contract). */
const MAX_TXN_KOBO = 10_000_000;
const MIN_TXN_KOBO = 100;
const BATCH_SYNC_LIMIT = 200;

// ── Terminal-token auth ───────────────────────────────────────────────────────

const TERMINAL_TOKEN_HEADER = "x-terminal-token";

function posHmacSecret(): string {
  const direct = process.env.POS_HMAC_SECRET ?? "";
  if (direct) return direct;
  if (ENV.isProduction) {
    // Fail closed in production — a POS endpoint without an HMAC secret must
    // never accept terminal traffic.
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "POS_HMAC_SECRET is not configured",
    });
  }
  // Dev/test fallback chain, mirroring deviceHeartbeat.ts heartbeatSecret().
  const fallback = ENV.deviceHeartbeatSecret || ENV.nfcMasterSecret || ENV.cookieSecret;
  if (!fallback) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "POS HMAC secret is not configured",
    });
  }
  return fallback;
}

/** Token a terminal must present: HMAC_SHA256(secret, "terminal:" + terminalId). */
export function computeTerminalToken(terminalId: string): string {
  return createHmac("sha256", posHmacSecret()).update(`terminal:${terminalId}`).digest("hex");
}

export function isValidTerminalToken(terminalId: string, token: string | null | undefined): boolean {
  if (!token) return false;
  const expected = computeTerminalToken(terminalId);
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function terminalTokenFromReq(req: TrpcContext["req"]): string | null {
  const raw = req?.headers?.[TERMINAL_TOKEN_HEADER];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * Verify the x-terminal-token header for the given terminalId and load the
 * terminal row. Throws UNAUTHORIZED / NOT_FOUND / PRECONDITION_FAILED.
 */
async function authenticateTerminal(
  ctx: Pick<TrpcContext, "req">,
  terminalId: string,
): Promise<{ db: Db; terminal: PosTerminalRow }> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  if (!isValidTerminalToken(terminalId, terminalTokenFromReq(ctx.req))) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid or missing x-terminal-token" });
  }
  const rows = await db.select().from(posTerminals).where(eq(posTerminals.terminalId, terminalId)).limit(1);
  const terminal = rows[0];
  if (!terminal) {
    throw new TRPCError({ code: "NOT_FOUND", message: `Terminal ${terminalId} is not registered` });
  }
  return { db, terminal };
}

function requireActiveTerminal(terminal: PosTerminalRow): void {
  if (terminal.status !== "active") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Terminal ${terminal.terminalId} is ${terminal.status} — only active terminals may transact`,
    });
  }
}

// ── Guarded side-effects (never break the money path) ─────────────────────────

/** Emit to the wallet.events Kafka topic; no-op when Kafka is disabled. */
async function emitWalletEvent(key: string, payload: Record<string, unknown>): Promise<void> {
  try {
    if (!kafkaEnabled()) return;
    await publishEvent(TOPICS.walletEvents, key, payload);
  } catch (err) {
    console.warn(`[POS] Failed to emit wallet event (${key}):`, (err as Error).message);
  }
}

interface CounterLike {
  inc(labels?: Record<string, string>, value?: number): void;
}
interface PromClientLike {
  Counter: new (opts: { name: string; help: string; labelNames?: string[]; registers?: unknown[] }) => CounterLike;
  register: unknown;
}

let _posTxnCounter: CounterLike | null | undefined;

/** Prometheus counter for POS outcomes; no-op when prom-client is absent. */
async function countPosTransaction(type: string, outcome: string): Promise<void> {
  try {
    if (_posTxnCounter === undefined) {
      const prom = await importOptional<PromClientLike>("prom-client", "POS");
      _posTxnCounter = prom
        ? new prom.Counter({
            name: "np_pos_transactions_total",
            help: "POS transaction outcomes",
            labelNames: ["type", "outcome"],
            registers: [prom.register],
          })
        : null;
    }
    _posTxnCounter?.inc({ type, outcome });
  } catch {
    // metrics must never break money paths
  }
}

// ── Shared input schemas ──────────────────────────────────────────────────────

const paginationInput = {
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
};

/** A single POS card transaction record (also the batchSync item shape). */
const posRecordInput = z.object({
  /** Terminal-generated UUID — idempotency key */
  txnUid: z.string().uuid(),
  terminalId: z.string().min(3).max(64),
  type: z.enum(TXN_TYPES),
  amountKobo: z.number().int().min(MIN_TXN_KOBO).max(MAX_TXN_KOBO),
  cardLast4: z.string().regex(/^\d{4}$/, "cardLast4 must be exactly 4 digits"),
  cardScheme: z.string().min(2).max(32),
  /** Retrieval reference number from the card network */
  rrn: z.string().min(1).max(64),
  /** System trace audit number */
  stan: z.string().min(1).max(32),
  /** Explicit wallet link (wallet_accounts.id) for wallet_topup */
  walletId: z.number().int().positive().optional(),
  /** RFID tag EPC — resolves the wallet via rfid_tags when walletId is absent */
  tagEpc: z.string().min(4).max(64).optional(),
  laneEventId: z.number().int().positive().optional(),
  occurredAt: z.coerce.date().optional(),
});

type PosRecordInput = z.infer<typeof posRecordInput>;

// ── Transaction pipeline ──────────────────────────────────────────────────────

/** Run inside a DB transaction where the driver supports it. */
async function inTx<T>(db: Db, fn: (tx: DbHandle) => Promise<T>): Promise<T> {
  if (typeof (db as { transaction?: unknown }).transaction === "function") {
    return db.transaction((tx) => fn(tx as unknown as DbHandle));
  }
  return fn(db);
}

/** Resolve the wallet for a record: explicit walletId, else active RFID tag. */
async function resolveWalletId(db: DbHandle, input: PosRecordInput): Promise<number | null> {
  if (input.walletId != null) return input.walletId;
  if (!input.tagEpc) return null;
  const rows = await db
    .select({ walletId: rfidTags.walletId })
    .from(rfidTags)
    .where(and(eq(rfidTags.tagEpc, input.tagEpc), eq(rfidTags.status, "active")))
    .limit(1);
  return rows[0]?.walletId ?? null;
}

export interface ProcessedPosRecord {
  txnUid: string;
  id?: number;
  status: PosTxnStatus;
  duplicate: boolean;
  walletCredit: { status: string; newBalanceKobo?: number } | null;
}

/**
 * Record one POS transaction end-to-end:
 *  (a) idempotency by txnUid — an existing row is returned as-is (never
 *      re-credited);
 *  (b) caller guarantees the terminal is active;
 *  (c) insert the pos_transactions row with status 'approved';
 *  (d) wallet_topup with a resolved wallet → creditWalletAtomic with
 *      externalRef POS-<txnUid>; on failure the row is flipped back to
 *      'pending' and the error is surfaced (never silent).
 */
async function processPosRecord(
  db: Db,
  terminal: PosTerminalRow,
  input: PosRecordInput,
): Promise<ProcessedPosRecord> {
  // (a) idempotency
  const existing = await db
    .select()
    .from(posTransactions)
    .where(eq(posTransactions.txnUid, input.txnUid))
    .limit(1);
  if (existing[0]) {
    if (!existing[0].syncedAt) {
      await db.update(posTransactions).set({ syncedAt: new Date() }).where(eq(posTransactions.id, existing[0].id));
    }
    return {
      txnUid: input.txnUid,
      id: existing[0].id,
      status: existing[0].status,
      duplicate: true,
      walletCredit: null,
    };
  }

  const walletId = await resolveWalletId(db, input);
  if (input.type === "wallet_topup" && walletId == null && (input.walletId != null || input.tagEpc)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `No active wallet resolved for top-up (walletId=${input.walletId ?? "none"}, tagEpc=${input.tagEpc ?? "none"})`,
    });
  }

  // (c) insert approved — txnUid unique constraint is the last-resort
  // idempotency guard against concurrent replays.
  const occurredAt = input.occurredAt ?? new Date();
  const inserted = await inTx(db, async (tx) => {
    const rows = await tx
      .insert(posTransactions)
      .values({
        txnUid: input.txnUid,
        terminalId: terminal.id,
        type: input.type,
        amountKobo: input.amountKobo,
        cardLast4: input.cardLast4,
        cardScheme: input.cardScheme,
        rrn: input.rrn,
        stan: input.stan,
        status: "approved",
        walletId: walletId ?? null,
        laneEventId: input.laneEventId ?? null,
        occurredAt,
        syncedAt: new Date(),
      })
      .onConflictDoNothing({ target: posTransactions.txnUid })
      .returning();
    return rows[0];
  });

  if (!inserted) {
    // Lost an insert race — the concurrent request created the row.
    const raced = await db
      .select()
      .from(posTransactions)
      .where(eq(posTransactions.txnUid, input.txnUid))
      .limit(1);
    if (raced[0]) {
      return { txnUid: input.txnUid, id: raced[0].id, status: raced[0].status, duplicate: true, walletCredit: null };
    }
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Failed to record POS transaction" });
  }

  // (d) wallet credit for top-ups
  let walletCredit: ProcessedPosRecord["walletCredit"] = null;
  if (input.type === "wallet_topup" && walletId != null) {
    try {
      const walletRows = await db
        .select({ userId: walletAccounts.userId })
        .from(walletAccounts)
        .where(eq(walletAccounts.id, walletId))
        .limit(1);
      const wallet = walletRows[0];
      if (!wallet) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Wallet ${walletId} not found` });
      }
      const credit = await creditWalletAtomic({
        userId: wallet.userId,
        amountKobo: input.amountKobo,
        externalRef: `POS-${input.txnUid}`,
        type: "topup",
        description: `POS top-up @ ${terminal.plazaId}`,
      });
      if (credit.status === "no_wallet") {
        throw new TRPCError({ code: "NOT_FOUND", message: `Wallet ${walletId} not found` });
      }
      walletCredit =
        credit.status === "credited"
          ? { status: "credited", newBalanceKobo: credit.newBalanceKobo }
          : { status: "duplicate" };
    } catch (err) {
      // Never silently swallow a credit failure: mark the row pending so ops
      // can retry/reconcile, then surface the error to the terminal.
      await db.update(posTransactions).set({ status: "pending" }).where(eq(posTransactions.id, inserted.id));
      void countPosTransaction(input.type, "credit_failed");
      if (err instanceof TRPCError) throw err;
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Wallet credit failed for POS-${input.txnUid}: ${(err as Error).message}`,
      });
    }
  }

  return { txnUid: input.txnUid, id: inserted.id, status: "approved", duplicate: false, walletCredit };
}

// ── Router ────────────────────────────────────────────────────────────────────

export const posRouter = router({
  // ── Terminal management (admin) ────────────────────────────────────────────

  registerTerminal: adminProcedure
    .input(
      z.object({
        terminalId: z.string().min(3).max(64),
        plazaId: z.string().min(1).max(64),
        vendor: z.enum(POS_VENDORS),
        serialNumber: z.string().min(1).max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const existing = await db
        .select({ id: posTerminals.id })
        .from(posTerminals)
        .where(eq(posTerminals.terminalId, input.terminalId))
        .limit(1);
      if (existing[0]) {
        throw new TRPCError({ code: "CONFLICT", message: `Terminal ${input.terminalId} is already registered` });
      }

      const [row] = await db
        .insert(posTerminals)
        .values({
          terminalId: input.terminalId,
          plazaId: input.plazaId,
          vendor: input.vendor,
          serialNumber: input.serialNumber ?? null,
          status: "active",
          registeredBy: ctx.user.id,
        })
        .returning();

      void writeAuditLog({
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
        action: "pos.terminal.register",
        entity: "pos_terminal",
        entityId: input.terminalId,
        diff: { plazaId: input.plazaId, vendor: input.vendor, serialNumber: input.serialNumber ?? null },
      });
      void countPosTransaction("terminal", "registered");
      return row;
    }),

  updateTerminal: adminProcedure
    .input(
      z
        .object({
          terminalId: z.string().min(3).max(64),
          status: z.enum(TERMINAL_STATUSES).optional(),
          plazaId: z.string().min(1).max(64).optional(),
        })
        .refine((v) => v.status !== undefined || v.plazaId !== undefined, {
          message: "Provide at least one of status or plazaId",
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const existing = await db
        .select()
        .from(posTerminals)
        .where(eq(posTerminals.terminalId, input.terminalId))
        .limit(1);
      if (!existing[0]) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Terminal ${input.terminalId} is not registered` });
      }

      const set: Partial<Pick<PosTerminalRow, "status" | "plazaId">> = {};
      if (input.status !== undefined) set.status = input.status;
      if (input.plazaId !== undefined) set.plazaId = input.plazaId;

      const [row] = await db
        .update(posTerminals)
        .set(set)
        .where(eq(posTerminals.terminalId, input.terminalId))
        .returning();

      void writeAuditLog({
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
        action: "pos.terminal.update",
        entity: "pos_terminal",
        entityId: input.terminalId,
        diff: { from: { status: existing[0].status, plazaId: existing[0].plazaId }, to: set },
      });
      return row;
    }),

  revokeTerminal: adminProcedure
    .input(
      z.object({
        terminalId: z.string().min(3).max(64),
        reason: z.string().min(5).max(500).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const existing = await db
        .select()
        .from(posTerminals)
        .where(eq(posTerminals.terminalId, input.terminalId))
        .limit(1);
      if (!existing[0]) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Terminal ${input.terminalId} is not registered` });
      }
      if (existing[0].status === "revoked") {
        return { ...existing[0], alreadyRevoked: true as const };
      }

      const [row] = await db
        .update(posTerminals)
        .set({ status: "revoked" })
        .where(eq(posTerminals.terminalId, input.terminalId))
        .returning();

      void writeAuditLog({
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
        action: "pos.terminal.revoke",
        entity: "pos_terminal",
        entityId: input.terminalId,
        diff: { reason: input.reason ?? null },
      });
      void countPosTransaction("terminal", "revoked");
      return { ...row, alreadyRevoked: false as const };
    }),

  listTerminals: adminProcedure
    .input(
      z.object({
        ...paginationInput,
        plazaId: z.string().optional(),
        status: z.enum(TERMINAL_STATUSES).optional(),
        vendor: z.enum(POS_VENDORS).optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const conds = [];
      if (input.plazaId) conds.push(eq(posTerminals.plazaId, input.plazaId));
      if (input.status) conds.push(eq(posTerminals.status, input.status));
      if (input.vendor) conds.push(eq(posTerminals.vendor, input.vendor));
      const where = conds.length ? and(...conds) : undefined;

      const items = await db
        .select()
        .from(posTerminals)
        .where(where)
        .orderBy(desc(posTerminals.createdAt))
        .limit(input.limit)
        .offset(input.offset);
      const totalRows = await db.select({ total: count() }).from(posTerminals).where(where);

      return { items, total: Number(totalRows[0]?.total ?? 0), limit: input.limit, offset: input.offset };
    }),

  // ── Terminal-authenticated procedures ──────────────────────────────────────

  terminalHeartbeat: publicProcedure
    .input(z.object({ terminalId: z.string().min(3).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const { db, terminal } = await authenticateTerminal(ctx, input.terminalId);
      if (terminal.status === "revoked") {
        throw new TRPCError({ code: "FORBIDDEN", message: `Terminal ${terminal.terminalId} is revoked` });
      }
      const now = new Date();
      await db.update(posTerminals).set({ lastSeenAt: now }).where(eq(posTerminals.id, terminal.id));
      return { ok: true as const, terminalId: terminal.terminalId, status: terminal.status, lastSeenAt: now };
    }),

  recordTransaction: publicProcedure.input(posRecordInput).mutation(async ({ ctx, input }) => {
    const { db, terminal } = await authenticateTerminal(ctx, input.terminalId);
    requireActiveTerminal(terminal);

    const result = await processPosRecord(db, terminal, input);

    void writeAuditLog({
      actorUserId: null,
      actorRole: "pos_terminal",
      action: result.duplicate ? "pos.txn.replay" : "pos.txn.record",
      entity: "pos_transaction",
      entityId: input.txnUid,
      diff: {
        terminalId: terminal.terminalId,
        plazaId: terminal.plazaId,
        type: input.type,
        amountKobo: input.amountKobo,
        status: result.status,
        walletCredit: result.walletCredit,
      },
    });
    if (!result.duplicate) {
      void emitWalletEvent(`POS-${input.txnUid}`, {
        kind: "pos.transaction",
        txnUid: input.txnUid,
        terminalId: terminal.terminalId,
        plazaId: terminal.plazaId,
        type: input.type,
        amountKobo: input.amountKobo,
        walletId: result.walletCredit ? input.walletId ?? null : null,
        walletCredit: result.walletCredit,
        occurredAt: (input.occurredAt ?? new Date()).toISOString(),
      });
    }
    void countPosTransaction(input.type, result.duplicate ? "duplicate" : "recorded");
    return result;
  }),

  /**
   * Offline POS queue sync — up to 200 records, each processed independently.
   * Per-item failures (validation, credit errors, terminal mismatch) are
   * isolated and reported; they never abort the rest of the batch.
   */
  batchSync: publicProcedure
    .input(
      z.object({
        terminalId: z.string().min(3).max(64),
        records: z.array(z.unknown()).min(1).max(BATCH_SYNC_LIMIT),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { db, terminal } = await authenticateTerminal(ctx, input.terminalId);
      requireActiveTerminal(terminal);

      const results: Array<{
        txnUid: string;
        status: PosTxnStatus | null;
        duplicate: boolean;
        error: string | null;
      }> = [];
      let succeeded = 0;
      let failed = 0;

      for (const raw of input.records) {
        const parsed = posRecordInput.safeParse(raw);
        const txnUid =
          typeof raw === "object" && raw !== null && typeof (raw as { txnUid?: unknown }).txnUid === "string"
            ? ((raw as { txnUid: string }).txnUid)
            : "unknown";
        if (!parsed.success) {
          failed++;
          results.push({ txnUid, status: null, duplicate: false, error: parsed.error.issues[0]?.message ?? "invalid record" });
          continue;
        }
        const rec = parsed.data;
        try {
          if (rec.terminalId !== terminal.terminalId) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Record terminalId does not match the authenticated terminal",
            });
          }
          const r = await processPosRecord(db, terminal, rec);
          succeeded++;
          results.push({ txnUid: rec.txnUid, status: r.status, duplicate: r.duplicate, error: null });
        } catch (err) {
          failed++;
          const message = err instanceof TRPCError ? `${err.code}: ${err.message}` : (err as Error).message;
          results.push({ txnUid: rec.txnUid, status: null, duplicate: false, error: message });
        }
      }

      void writeAuditLog({
        actorUserId: null,
        actorRole: "pos_terminal",
        action: "pos.txn.batchSync",
        entity: "pos_terminal",
        entityId: terminal.terminalId,
        diff: { received: input.records.length, succeeded, failed },
      });
      void countPosTransaction("sync", failed > 0 ? "partial" : "ok");
      return { results, succeeded, failed };
    }),

  // ── Reversal (admin, 4-eyes over ₦50,000) ──────────────────────────────────

  reverseTransaction: adminProcedure
    .input(
      z.object({
        txnUid: z.string().uuid(),
        reason: z.string().min(5).max(500),
        /**
         * Second approving admin's user id — REQUIRED for reversals above
         * ₦50,000 (4-eyes principle, mirrors admin.issueRefund/approveRefund).
         * Must reference a different admin user than the requester.
         */
        secondAdminId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const rows = await db.select().from(posTransactions).where(eq(posTransactions.txnUid, input.txnUid)).limit(1);
      const txn = rows[0];
      if (!txn) throw new TRPCError({ code: "NOT_FOUND", message: `POS transaction ${input.txnUid} not found` });
      if (txn.status === "reversed") {
        return { txnUid: input.txnUid, status: "reversed" as const, duplicate: true, walletDebit: null };
      }
      if (txn.status !== "approved") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Only approved transactions can be reversed (current status: ${txn.status})`,
        });
      }

      // 4-eyes: large reversals require a second admin's sign-off.
      const needsSecondApproval = txn.amountKobo > FOUR_EYES_THRESHOLD_KOBO;
      if (needsSecondApproval) {
        if (input.secondAdminId == null) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "4-eyes: reversals over ₦50,000 require a second admin — pass secondAdminId",
          });
        }
        if (input.secondAdminId === ctx.user.id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "4-eyes violation: the requester cannot be their own second approver",
          });
        }
        const approverRows = await db
          .select({ id: users.id, role: users.role })
          .from(users)
          .where(eq(users.id, input.secondAdminId))
          .limit(1);
        if (!approverRows[0] || approverRows[0].role !== "admin") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "secondAdminId must reference a different admin user",
          });
        }
      }

      // Offsetting ledger entry when the original txn credited a wallet.
      let walletDebit: { status: string; newBalanceKobo?: number } | null = null;
      if (txn.type === "wallet_topup" && txn.walletId != null) {
        const walletRows = await db
          .select({ userId: walletAccounts.userId })
          .from(walletAccounts)
          .where(eq(walletAccounts.id, txn.walletId))
          .limit(1);
        const wallet = walletRows[0];
        if (!wallet) {
          // Surface loudly — reversal proceeds but is flagged for ops.
          walletDebit = { status: "no_wallet" };
        } else {
          const terminalRows = await db
            .select({ plazaId: posTerminals.plazaId })
            .from(posTerminals)
            .where(eq(posTerminals.id, txn.terminalId))
            .limit(1);
          const plazaId = terminalRows[0]?.plazaId ?? undefined;
          const debit = await debitWalletAtomic({
            userId: wallet.userId,
            amountKobo: txn.amountKobo,
            externalRef: `POS-REV-${txn.txnUid}`,
            description: `POS reversal${plazaId ? ` @ ${plazaId}` : ""} — ${input.reason}`,
            plazaId,
          });
          walletDebit =
            debit.status === "debited"
              ? { status: "debited", newBalanceKobo: debit.newBalanceKobo }
              : debit.status === "insufficient_funds"
                ? { status: "insufficient_funds" }
                : debit.status === "daily_cap_exceeded"
                  ? { status: "daily_cap_exceeded" }
                  : { status: debit.status };
        }
      }

      await db.update(posTransactions).set({ status: "reversed" }).where(eq(posTransactions.id, txn.id));

      void writeAuditLog({
        actorUserId: ctx.user.id,
        actorRole: ctx.user.role,
        action: "pos.txn.reverse",
        entity: "pos_transaction",
        entityId: input.txnUid,
        diff: {
          reason: input.reason,
          amountKobo: txn.amountKobo,
          walletId: txn.walletId,
          needsSecondApproval,
          secondAdminId: input.secondAdminId ?? null,
          walletDebit,
        },
      });
      void emitWalletEvent(`POS-REV-${input.txnUid}`, {
        kind: "pos.reversal",
        txnUid: input.txnUid,
        amountKobo: txn.amountKobo,
        walletId: txn.walletId,
        walletDebit,
        reversedBy: ctx.user.id,
        secondAdminId: input.secondAdminId ?? null,
      });
      void countPosTransaction(txn.type, walletDebit && walletDebit.status !== "debited" && walletDebit.status !== "duplicate"
        ? "reversal_debit_flagged"
        : "reversed");

      return { txnUid: input.txnUid, status: "reversed" as const, duplicate: false, walletDebit };
    }),

  // ── Read models (operator/admin) ───────────────────────────────────────────

  listTransactions: operatorProcedure
    .input(
      z.object({
        ...paginationInput,
        terminalId: z.string().optional(),
        plazaId: z.string().optional(),
        status: z.enum(TXN_STATUSES).optional(),
        type: z.enum(TXN_TYPES).optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const conds = [];
      if (input.terminalId) conds.push(eq(posTerminals.terminalId, input.terminalId));
      if (input.plazaId) conds.push(eq(posTerminals.plazaId, input.plazaId));
      if (input.status) conds.push(eq(posTransactions.status, input.status));
      if (input.type) conds.push(eq(posTransactions.type, input.type));
      if (input.from) conds.push(gte(posTransactions.occurredAt, input.from));
      if (input.to) conds.push(lte(posTransactions.occurredAt, input.to));
      const where = conds.length ? and(...conds) : undefined;

      const joinOn = eq(posTransactions.terminalId, posTerminals.id);
      const items = await db
        .select({
          txn: posTransactions,
          terminalId: posTerminals.terminalId,
          plazaId: posTerminals.plazaId,
        })
        .from(posTransactions)
        .leftJoin(posTerminals, joinOn)
        .where(where)
        .orderBy(desc(posTransactions.occurredAt))
        .limit(input.limit)
        .offset(input.offset);
      const totalRows = await db
        .select({ total: count() })
        .from(posTransactions)
        .leftJoin(posTerminals, joinOn)
        .where(where);

      return { items, total: Number(totalRows[0]?.total ?? 0), limit: input.limit, offset: input.offset };
    }),

  /**
   * Per-terminal totals for a calendar day (UTC), broken down by type and
   * status — the POS side of the POS-vs-ledger reconciliation.
   */
  terminalDailySummary: operatorProcedure
    .input(
      z.object({
        terminalId: z.string().optional(),
        date: z.coerce.date().optional(),
      }),
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const day = input.date ?? new Date();
      const dayStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

      const conds = [gte(posTransactions.occurredAt, dayStart), lt(posTransactions.occurredAt, dayEnd)];
      if (input.terminalId) conds.push(eq(posTerminals.terminalId, input.terminalId));

      const rows = await db
        .select({
          txn: posTransactions,
          terminalId: posTerminals.terminalId,
          plazaId: posTerminals.plazaId,
        })
        .from(posTransactions)
        .leftJoin(posTerminals, eq(posTransactions.terminalId, posTerminals.id))
        .where(and(...conds))
        .orderBy(desc(posTransactions.occurredAt))
        .limit(10_000);

      interface Bucket { count: number; totalKobo: number }
      interface TerminalSummary {
        terminalId: string | null;
        plazaId: string | null;
        totalCount: number;
        totalKobo: number;
        byType: Record<string, Bucket>;
        byStatus: Record<string, Bucket>;
      }
      const perTerminal = new Map<string, TerminalSummary>();
      const bump = (rec: Record<string, Bucket>, key: string, amount: number) => {
        const b = (rec[key] ??= { count: 0, totalKobo: 0 });
        b.count += 1;
        b.totalKobo += amount;
      };

      for (const row of rows) {
        const key = row.terminalId ?? `pk:${row.txn.terminalId}`;
        const summary = (perTerminal.get(key) ??
          perTerminal.set(key, {
            terminalId: row.terminalId ?? null,
            plazaId: row.plazaId ?? null,
            totalCount: 0,
            totalKobo: 0,
            byType: {},
            byStatus: {},
          }).get(key))!;
        summary.totalCount += 1;
        summary.totalKobo += row.txn.amountKobo;
        bump(summary.byType, row.txn.type, row.txn.amountKobo);
        bump(summary.byStatus, row.txn.status, row.txn.amountKobo);
      }

      return {
        date: dayStart.toISOString().slice(0, 10),
        terminals: Array.from(perTerminal.values()),
      };
    }),
});

export type PosRouter = typeof posRouter;
