/**
 * RFID Lane Middleware tRPC Router
 * ================================
 * Ingests tag reads from lane controllers (RFID/eTag readers at toll plazas),
 * runs the anti-fraud + charging pipeline, and records an immutable
 * lane_events ledger row for every read.
 *
 * Pipeline (processLaneEvent):
 *   a. Idempotency     — eventUid is UNIQUE; replays return the stored result.
 *   b. Tag resolution  — tagEpc must exist and be 'active', else 'failed'.
 *   c. Anti-passback   — same tag at same plaza within 5 minutes → blocked,
 *                        no charge, still recorded.
 *   d. Fraud scoring   — server/ml/scoring.ts scoreFraud over lane features
 *                        (velocity 1h/24h, amount z-score, wallet age).
 *                        Non-blocking: failures fall back to the deterministic
 *                        heuristic and never prevent charging.
 *   e. Toll charge     — same atomic logic as wallet.chargeToll:
 *                        debitWalletAtomic keyed by the tag's wallet owner with
 *                        idempotency key = eventUid. Insufficient funds →
 *                        chargeStatus 'insufficient' (balance never negative).
 *   f. Ledger insert   — lane_events row with the outcome.
 *   g. Audit + Kafka   — audit log line + best-effort publish to
 *                        topic toll.charges (dynamic import, try/catch).
 *   h. Metrics         — best-effort counter via server/integrations/metrics.ts
 *                        (dynamic import, try/catch).
 *
 * Lane-controller authentication (audit v13, P0-9 pattern):
 *   x-lane-token = HMAC_SHA256(secret, "lane:" + readerId)
 *   secret = LANE_HMAC_SECRET, falling back to NFC_MASTER_SECRET only when
 *   LANE_HMAC_SECRET is unset. If neither is configured the endpoint FAILS
 *   CLOSED (PRECONDITION_FAILED) — see docs/ETAG-RFID-POS.md.
 *
 * Procedures:
 *  - lanes.ingestEvent  (lane HMAC)  — single event from a lane controller
 *  - lanes.ingestBatch  (lane HMAC)  — ≤500 events, store-and-forward replay;
 *                                      one bad item never fails the batch
 *  - lanes.recentEvents (operator/admin)          — paginated, joined tag/wallet
 *  - lanes.laneSummary  (operator/admin)          — per-plaza daily aggregates
 *  - lanes.tagHistory   (operator/admin/reviewer or owner) — events per tag
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import crypto from "crypto";
import { operatorProcedure, protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb, debitWalletAtomic } from "../db";
import { laneEvents, rfidTags, walletAccounts } from "../../drizzle/schema";
import type { LaneEvent, RfidTag } from "../../drizzle/schema";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { writeAuditLog } from "../_core/audit";
import { ENV } from "../_core/env";
import type { TrpcContext } from "../_core/context";

// ── Lane-controller HMAC authentication ───────────────────────────────────────

/**
 * Secret resolution order: LANE_HMAC_SECRET first; NFC_MASTER_SECRET only as a
 * fallback when LANE_HMAC_SECRET is unset (single-secret deployments).
 * Returns null when neither is configured → callers must fail closed.
 */
function laneSecret(): string | null {
  return process.env.LANE_HMAC_SECRET || ENV.nfcMasterSecret || null;
}

export function computeLaneToken(readerId: string): string | null {
  const secret = laneSecret();
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(`lane:${readerId}`).digest("hex");
}

export function isValidLaneToken(readerId: string, token: string | undefined | null): boolean {
  const expected = computeLaneToken(readerId);
  if (!expected || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Extract + verify the lane token from the request headers. Fail closed. */
function assertLaneAuth(ctx: Pick<TrpcContext, "req">, readerId: string): void {
  if (!laneSecret()) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Lane authentication is not configured (LANE_HMAC_SECRET unset)",
    });
  }
  const headers = (ctx.req?.headers ?? {}) as Record<string, string | string[] | undefined>;
  const raw = headers["x-lane-token"];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!isValidLaneToken(readerId, token)) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid lane token" });
  }
}

// ── Tariff configuration ──────────────────────────────────────────────────────

/**
 * Flat per-plaza exit tariff in kobo. Entry reads are free (open system
 * records the crossing, exit computes the fare). Amounts supplied by the
 * lane controller for exit events override the map (distance-based pricing).
 */
export const PLAZA_TARIFFS_KOBO: Record<string, number> = {
  "lagos-ibadan": 50_000,      // ₦500
  "lekki-ikoyi": 40_000,       // ₦400
  "abuja-keffi": 30_000,       // ₦300
  "second-niger": 60_000,      // ₦600
  "default": 25_000,           // ₦250 fallback
};

export const DEFAULT_TOLL_KOBO = PLAZA_TARIFFS_KOBO["default"]!;

export function tariffForPlaza(plazaId: string): number {
  return PLAZA_TARIFFS_KOBO[plazaId.trim().toLowerCase()] ?? DEFAULT_TOLL_KOBO;
}

/** Anti-passback window: a tag read twice at one plaza within this window is blocked. */
export const ANTI_PASSBACK_WINDOW_MS = 5 * 60 * 1000;

// ── Shared types ──────────────────────────────────────────────────────────────

const laneEventInputSchema = z.object({
  eventUid: z.string().uuid(),
  plazaId: z.string().trim().min(1).max(64),
  laneId: z.string().trim().min(1).max(64),
  readerId: z.string().trim().min(1).max(64),
  deviceId: z.number().int().positive().optional(),
  tagEpc: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[0-9A-F]{24}$/.test(v), {
      message: "tagEpc must be a 24-character uppercase hex EPC-96 identifier",
    }),
  direction: z.enum(["entry", "exit"]).default("exit"),
  /** Exit events may carry a distance-based amount that overrides the tariff map. */
  amountKobo: z.number().int().min(0).max(10_000_000).optional(),
  occurredAt: z.coerce.date(),
});

export type LaneEventInput = z.infer<typeof laneEventInputSchema>;

export interface LaneEventResult {
  eventUid: string;
  chargeStatus: LaneEvent["chargeStatus"];
  /** true when the eventUid was already processed (idempotent replay) */
  duplicate: boolean;
  laneEventId?: number;
  walletId?: number | null;
  amountKobo?: number;
  balanceAfter?: number;
  fraudScore?: number | null;
  antiPassbackBlocked?: boolean;
  reason?: string;
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

// ── Fraud feature assembly + scoring (non-blocking) ──────────────────────────

async function scoreLaneEvent(
  tag: RfidTag,
  input: LaneEventInput,
  amountKobo: number,
  recentEvents: LaneEvent[],
  walletCreatedAt: Date | null,
): Promise<number | null> {
  try {
    const { scoreFraud } = await import("../ml/scoring");
    const now = input.occurredAt.getTime();
    const txCount1h = recentEvents.filter((e) => now - e.occurredAt.getTime() <= 3_600_000).length + 1;
    const txCount24h = recentEvents.length + 1;

    // Amount z-score vs this tag's own history (in naira, per ml/features convention)
    const amounts = recentEvents.map((e) => e.amountKobo / 100);
    const mean = amounts.length > 0 ? amounts.reduce((a, b) => a + b, 0) / amounts.length : amountKobo / 100;
    const variance = amounts.length > 1
      ? amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / (amounts.length - 1)
      : 1;
    const std = Math.max(Math.sqrt(variance), 1);
    const amountNaira = Math.max(amountKobo / 100, 0);

    const walletAgeDays = walletCreatedAt
      ? Math.max(0, (now - walletCreatedAt.getTime()) / 86_400_000)
      : 0;

    const score = await scoreFraud({
      amount_log: Math.log1p(amountNaira),
      amount_z: Math.max(-8, Math.min(8, (amountNaira - mean) / std)),
      tx_count_1h: txCount1h,
      tx_count_24h: txCount24h,
      device_degree: 1,
      ip_degree: 1,
      kyc_age_days: walletAgeDays,
      kyc_tier: tag.kycApplicationId ? 2 : 1,
      hour_sin: Math.sin((2 * Math.PI * (new Date(now).getUTCHours() + 1) % 24) / 24),
      hour_cos: Math.cos((2 * Math.PI * (new Date(now).getUTCHours() + 1) % 24) / 24),
      is_night: (() => { const h = (new Date(now).getUTCHours() + 1) % 24; return h < 6 || h >= 23 ? 1 : 0; })(),
      days_since_signup: walletAgeDays,
      is_transfer: 0,
      is_topup: 0,
    });
    return score.fraud_probability;
  } catch (err) {
    console.warn("[Lanes] Fraud scoring failed (non-blocking):", err);
    return null;
  }
}

// ── Best-effort event publishing / metrics (dynamic import guards) ───────────

async function publishLaneCharge(result: LaneEventResult, input: LaneEventInput): Promise<void> {
  try {
    const kafka = await import("../integrations/kafka");
    await kafka.publishEvent(kafka.TOPICS.tollCharges, input.eventUid, {
      eventUid: input.eventUid,
      plazaId: input.plazaId,
      laneId: input.laneId,
      tagEpc: input.tagEpc,
      chargeStatus: result.chargeStatus,
      amountKobo: result.amountKobo ?? 0,
      walletId: result.walletId ?? null,
      occurredAt: input.occurredAt.toISOString(),
    });
  } catch {
    // Kafka unavailable — the lane_events row is the source of truth.
  }
}

async function countLaneMetric(outcome: "ok" | "duplicate" | "error"): Promise<void> {
  try {
    const metrics = await import("../integrations/metrics");
    // countWebhook is the existing counter helper; lane events reuse it with
    // provider 'interswitch' semantics avoided — a dedicated counter is used
    // when present, otherwise we no-op (metrics must never break charging).
    const mod = metrics as unknown as Record<string, unknown>;
    if (typeof mod.countLaneEvent === "function") {
      await (mod.countLaneEvent as (o: string) => Promise<void>)(outcome);
    }
  } catch {
    // non-fatal
  }
}

// ── Core pipeline ─────────────────────────────────────────────────────────────

/**
 * Process one lane event end-to-end. Exported for tests and for the POS
 * router (crossing settlement). Never throws for business-rule outcomes —
 * they are recorded as lane_events rows with a non-'charged' chargeStatus.
 */
export async function processLaneEvent(
  db: Db,
  input: LaneEventInput,
): Promise<LaneEventResult> {
  // (a) Idempotency — a stored row for this eventUid means we already
  // processed it (offline replay, controller retry). Return the stored result.
  const [existing] = await db
    .select()
    .from(laneEvents)
    .where(eq(laneEvents.eventUid, input.eventUid))
    .limit(1);
  if (existing) {
    return {
      eventUid: input.eventUid,
      chargeStatus: existing.chargeStatus,
      duplicate: true,
      laneEventId: existing.id,
      walletId: existing.walletId,
      amountKobo: existing.amountKobo,
      fraudScore: existing.fraudScore,
      antiPassbackBlocked: existing.antiPassbackBlocked,
      reason: "duplicate_event",
    };
  }

  const amountKobo = input.amountKobo ?? tariffForPlaza(input.plazaId);
  const rawPayload: Record<string, unknown> = {
    eventUid: input.eventUid,
    plazaId: input.plazaId,
    laneId: input.laneId,
    readerId: input.readerId,
    deviceId: input.deviceId ?? null,
    tagEpc: input.tagEpc,
    direction: input.direction,
    amountKobo: input.amountKobo ?? null,
    occurredAt: input.occurredAt.toISOString(),
  };

  // (b) Tag resolution
  const [tag] = await db
    .select()
    .from(rfidTags)
    .where(eq(rfidTags.tagEpc, input.tagEpc))
    .limit(1);

  if (!tag || tag.status !== "active") {
    const reason = !tag ? "unknown_tag" : `tag_${tag.status}`;
    const [row] = await insertLaneEvent(db, input, {
      walletId: tag?.walletId ?? null,
      amountKobo,
      chargeStatus: "failed",
      fraudScore: null,
      antiPassbackBlocked: false,
      rawPayload: { ...rawPayload, failureReason: reason },
    });
    void writeAuditLog({
      actorUserId: null,
      action: "lane.charge_failed",
      entity: "lane_event",
      entityId: input.eventUid,
      diff: { tagEpc: input.tagEpc, plazaId: input.plazaId, reason },
    });
    void countLaneMetric("error");
    return {
      eventUid: input.eventUid,
      chargeStatus: "failed",
      duplicate: false,
      laneEventId: row?.id,
      walletId: tag?.walletId ?? null,
      amountKobo,
      reason,
    };
  }

  // Recent history for this tag — feeds anti-passback AND fraud velocity.
  const cutoff24h = new Date(input.occurredAt.getTime() - 86_400_000);
  const recent = await db
    .select()
    .from(laneEvents)
    .where(and(eq(laneEvents.tagEpc, input.tagEpc), gte(laneEvents.occurredAt, cutoff24h)))
    .orderBy(desc(laneEvents.occurredAt))
    .limit(200);

  // (c) Anti-passback — same tag, same plaza, within 5 minutes of a prior
  // UNBLOCKED read (blocked reads don't extend the window, otherwise a single
  // passback block would lock the tag out of the plaza indefinitely).
  const passback = recent.find(
    (e) =>
      !e.antiPassbackBlocked &&
      e.plazaId === input.plazaId &&
      Math.abs(input.occurredAt.getTime() - e.occurredAt.getTime()) < ANTI_PASSBACK_WINDOW_MS,
  );
  if (passback) {
    const [row] = await insertLaneEvent(db, input, {
      walletId: tag.walletId,
      amountKobo,
      chargeStatus: "failed",
      fraudScore: null,
      antiPassbackBlocked: true,
      rawPayload: { ...rawPayload, failureReason: "anti_passback", blockedByEventId: passback.id },
    });
    void writeAuditLog({
      actorUserId: null,
      action: "lane.anti_passback",
      entity: "lane_event",
      entityId: input.eventUid,
      diff: { tagEpc: input.tagEpc, plazaId: input.plazaId, blockedByEventUid: passback.eventUid },
    });
    void countLaneMetric("error");
    return {
      eventUid: input.eventUid,
      chargeStatus: "failed",
      duplicate: false,
      laneEventId: row?.id,
      walletId: tag.walletId,
      amountKobo,
      antiPassbackBlocked: true,
      reason: "anti_passback",
    };
  }

  // Free crossings: entry reads on an open system, or a zero fare.
  if (input.direction === "entry" || amountKobo === 0) {
    const fraudScore = await scoreLaneEvent(tag, input, amountKobo, recent, null);
    const [row] = await insertLaneEvent(db, input, {
      walletId: tag.walletId,
      amountKobo,
      chargeStatus: "free",
      fraudScore,
      antiPassbackBlocked: false,
      rawPayload,
    });
    return {
      eventUid: input.eventUid,
      chargeStatus: "free",
      duplicate: false,
      laneEventId: row?.id,
      walletId: tag.walletId,
      amountKobo,
      fraudScore,
    };
  }

  // Wallet resolution — a tag without a linked wallet cannot be charged.
  if (tag.walletId == null) {
    const [row] = await insertLaneEvent(db, input, {
      walletId: null,
      amountKobo,
      chargeStatus: "failed",
      fraudScore: null,
      antiPassbackBlocked: false,
      rawPayload: { ...rawPayload, failureReason: "no_wallet_linked" },
    });
    return {
      eventUid: input.eventUid,
      chargeStatus: "failed",
      duplicate: false,
      laneEventId: row?.id,
      amountKobo,
      reason: "no_wallet_linked",
    };
  }

  const [wallet] = await db
    .select()
    .from(walletAccounts)
    .where(eq(walletAccounts.id, tag.walletId))
    .limit(1);
  if (!wallet) {
    const [row] = await insertLaneEvent(db, input, {
      walletId: tag.walletId,
      amountKobo,
      chargeStatus: "failed",
      fraudScore: null,
      antiPassbackBlocked: false,
      rawPayload: { ...rawPayload, failureReason: "wallet_not_found" },
    });
    return {
      eventUid: input.eventUid,
      chargeStatus: "failed",
      duplicate: false,
      laneEventId: row?.id,
      walletId: tag.walletId,
      amountKobo,
      reason: "wallet_not_found",
    };
  }

  // (d) Fraud scoring — non-blocking, result stored on the ledger row.
  const fraudScore = await scoreLaneEvent(tag, input, amountKobo, recent, wallet.createdAt);

  // (e) Atomic toll charge — the SAME primitive as wallet.chargeToll:
  // conditional decrement (balance can never go negative), idempotent on
  // externalRef = eventUid, daily fare cap enforced inside the transaction.
  const outcome = await debitWalletAtomic({
    userId: wallet.userId,
    amountKobo,
    externalRef: `NP-LANE-${input.eventUid}`,
    plazaId: input.plazaId,
    description: `Lane toll ${input.plazaId} ${input.laneId} tag ${input.tagEpc}`,
  });

  if (outcome.status === "insufficient_funds" || outcome.status === "daily_cap_exceeded") {
    const reason = outcome.status;
    const [row] = await insertLaneEvent(db, input, {
      walletId: tag.walletId,
      amountKobo,
      chargeStatus: "insufficient",
      fraudScore,
      antiPassbackBlocked: false,
      rawPayload: { ...rawPayload, failureReason: reason },
    });
    void writeAuditLog({
      actorUserId: null,
      action: "lane.insufficient",
      entity: "lane_event",
      entityId: input.eventUid,
      diff: { tagEpc: input.tagEpc, walletId: tag.walletId, amountKobo, reason },
    });
    void countLaneMetric("error");
    return {
      eventUid: input.eventUid,
      chargeStatus: "insufficient",
      duplicate: false,
      laneEventId: row?.id,
      walletId: tag.walletId,
      amountKobo,
      fraudScore,
      reason,
    };
  }

  if (outcome.status !== "debited") {
    // no_wallet / duplicate at the wallet-ledger level — treat as failed so
    // reconciliation can pick the row up (the wallet ledger stays untouched).
    const [row] = await insertLaneEvent(db, input, {
      walletId: tag.walletId,
      amountKobo,
      chargeStatus: "failed",
      fraudScore,
      antiPassbackBlocked: false,
      rawPayload: { ...rawPayload, failureReason: outcome.status },
    });
    return {
      eventUid: input.eventUid,
      chargeStatus: "failed",
      duplicate: false,
      laneEventId: row?.id,
      walletId: tag.walletId,
      amountKobo,
      fraudScore,
      reason: outcome.status,
    };
  }

  // (f) Charged — record the ledger row with the wallet transaction link.
  const [row] = await insertLaneEvent(db, input, {
    walletId: tag.walletId,
    amountKobo,
    chargeStatus: "charged",
    fraudScore,
    antiPassbackBlocked: false,
    walletTxnId: outcome.transactionId,
    rawPayload,
  });

  // (g) Audit + Kafka (best-effort), (h) metrics (best-effort).
  void writeAuditLog({
    actorUserId: null,
    action: "lane.charge",
    entity: "lane_event",
    entityId: input.eventUid,
    diff: {
      tagEpc: input.tagEpc,
      plazaId: input.plazaId,
      laneId: input.laneId,
      walletId: tag.walletId,
      walletTxnId: outcome.transactionId,
      amountKobo,
      newBalanceKobo: outcome.newBalanceKobo,
      fraudScore,
    },
  });
  const result: LaneEventResult = {
    eventUid: input.eventUid,
    chargeStatus: "charged",
    duplicate: false,
    laneEventId: row?.id,
    walletId: tag.walletId,
    amountKobo,
    balanceAfter: outcome.newBalanceKobo,
    fraudScore,
  };
  void publishLaneCharge(result, input);
  void countLaneMetric("ok");
  return result;
}

async function insertLaneEvent(
  db: Db,
  input: LaneEventInput,
  fields: {
    walletId: number | null;
    amountKobo: number;
    chargeStatus: LaneEvent["chargeStatus"];
    fraudScore: number | null;
    antiPassbackBlocked: boolean;
    walletTxnId?: number;
    rawPayload: Record<string, unknown>;
  },
) {
  return db
    .insert(laneEvents)
    .values({
      eventUid: input.eventUid,
      plazaId: input.plazaId,
      laneId: input.laneId,
      readerId: input.readerId,
      deviceId: input.deviceId ?? null,
      tagEpc: input.tagEpc,
      walletId: fields.walletId,
      direction: input.direction,
      amountKobo: fields.amountKobo,
      chargeStatus: fields.chargeStatus,
      walletTxnId: fields.walletTxnId ?? null,
      fraudScore: fields.fraudScore,
      antiPassbackBlocked: fields.antiPassbackBlocked,
      occurredAt: input.occurredAt,
      rawPayload: fields.rawPayload,
    })
    .onConflictDoNothing({ target: laneEvents.eventUid })
    .returning();
}

// ── Router ────────────────────────────────────────────────────────────────────

const REVIEW_ROLES = ["admin", "operator", "installer", "reviewer"];

/**
 * Lane-controller endpoints authenticate via the x-lane-token HMAC header
 * (not a user session), so they build on publicProcedure + assertLaneAuth.
 */
const publicLaneProcedure = publicProcedure;

export const lanesRouter = router({
  /**
   * Ingest a single lane event. Authenticated via the lane-controller HMAC
   * token (x-lane-token = HMAC_SHA256(secret, "lane:" + readerId)), not a
   * user session.
   */
  ingestEvent: publicLaneProcedure
    .input(laneEventInputSchema)
    .mutation(async ({ ctx, input }) => {
      assertLaneAuth(ctx, input.readerId);
      const db = await getDb();
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      }
      return processLaneEvent(db, input);
    }),

  /**
   * Store-and-forward batch ingest for offline lanes: up to 500 events.
   * Per-item isolation — a malformed or failing item never fails the batch;
   * every item gets its own result entry.
   */
  ingestBatch: publicLaneProcedure
    .input(z.object({
      readerId: z.string().trim().min(1).max(64),
      // Items are validated individually below — a malformed payload must
      // never fail the whole store-and-forward batch.
      events: z.array(z.unknown()).min(1).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      assertLaneAuth(ctx, input.readerId);
      const db = await getDb();
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      }

      const results: LaneEventResult[] = [];
      for (const raw of input.events) {
        const parsed = laneEventInputSchema.safeParse(raw);
        if (!parsed.success) {
          results.push({
            eventUid: typeof (raw as { eventUid?: unknown })?.eventUid === "string"
              ? (raw as { eventUid: string }).eventUid
              : "invalid",
            chargeStatus: "failed",
            duplicate: false,
            reason: "invalid_payload",
          });
          continue;
        }
        const event = parsed.data;
        try {
          results.push(await processLaneEvent(db, event));
        } catch (err) {
          // Per-item isolation: one bad event must not fail the batch.
          console.warn(`[Lanes] Batch item ${event.eventUid} failed:`, err);
          results.push({
            eventUid: event.eventUid,
            chargeStatus: "failed",
            duplicate: false,
            reason: `processing_error: ${(err as Error).message}`,
          });
        }
      }

      return {
        received: input.events.length,
        processed: results.filter((r) => !r.duplicate).length,
        results,
      };
    }),

  /**
   * Paginated recent lane events (operator/admin), joined with tag + wallet.
   */
  recentEvents: operatorProcedure
    .input(z.object({
      plazaId: z.string().trim().min(1).max(64),
      page: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(100).default(50),
      chargeStatus: z.enum(["charged", "insufficient", "free", "exempt", "queued", "failed"]).optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const conditions = [eq(laneEvents.plazaId, input.plazaId)];
      if (input.chargeStatus) conditions.push(eq(laneEvents.chargeStatus, input.chargeStatus));
      const whereClause = conditions.length > 1 ? and(...conditions) : conditions[0];

      const rows = await db
        .select()
        .from(laneEvents)
        .where(whereClause)
        .orderBy(desc(laneEvents.occurredAt))
        .limit(input.limit)
        .offset((input.page - 1) * input.limit);

      // Join tag + wallet info in a second pass (bounded by page size).
      const epcs = [...new Set(rows.map((r) => r.tagEpc))];
      const walletIds = [...new Set(rows.map((r) => r.walletId).filter((v): v is number => v != null))];

      const [tags, wallets] = await Promise.all([
        epcs.length > 0
          ? db.select().from(rfidTags).where(inArray(rfidTags.tagEpc, epcs))
          : Promise.resolve([] as RfidTag[]),
        walletIds.length > 0
          ? db.select().from(walletAccounts).where(inArray(walletAccounts.id, walletIds))
          : Promise.resolve([] as (typeof walletAccounts.$inferSelect)[]),
      ]);
      const tagByEpc = new Map(tags.map((t) => [t.tagEpc, t]));
      const walletById = new Map(wallets.map((w) => [w.id, w]));

      return {
        events: rows.map((row) => {
          const tag = tagByEpc.get(row.tagEpc);
          const wallet = row.walletId != null ? walletById.get(row.walletId) : undefined;
          return {
            ...row,
            tag: tag
              ? { tagType: tag.tagType, status: tag.status, vehiclePlate: tag.vehiclePlate }
              : null,
            wallet: wallet
              ? { balanceKobo: wallet.balanceKobo, ownerUserId: wallet.userId }
              : null,
          };
        }),
        page: input.page,
        limit: input.limit,
      };
    }),

  /**
   * Per-plaza summary for today (WAT): counts by chargeStatus, charged
   * revenue, and the tags with the most insufficient-fund events.
   */
  laneSummary: operatorProcedure
    .input(z.object({
      plazaId: z.string().trim().min(1).max(64),
      topInsufficientLimit: z.number().int().min(1).max(20).default(5),
    }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // Start of today, West Africa Time (UTC+1).
      const nowWat = new Date(Date.now() + 3_600_000);
      const startOfDayWat = new Date(Date.UTC(
        nowWat.getUTCFullYear(), nowWat.getUTCMonth(), nowWat.getUTCDate(),
      ) - 3_600_000);

      const rows = await db
        .select()
        .from(laneEvents)
        .where(and(
          eq(laneEvents.plazaId, input.plazaId),
          gte(laneEvents.occurredAt, startOfDayWat),
        ))
        .orderBy(desc(laneEvents.occurredAt))
        .limit(5_000);

      const countsByStatus: Record<string, number> = {};
      let revenueKobo = 0;
      const insufficientByTag = new Map<string, number>();
      let antiPassbackBlocked = 0;

      for (const row of rows) {
        countsByStatus[row.chargeStatus] = (countsByStatus[row.chargeStatus] ?? 0) + 1;
        if (row.chargeStatus === "charged") revenueKobo += row.amountKobo;
        if (row.chargeStatus === "insufficient") {
          insufficientByTag.set(row.tagEpc, (insufficientByTag.get(row.tagEpc) ?? 0) + 1);
        }
        if (row.antiPassbackBlocked) antiPassbackBlocked++;
      }

      const topInsufficientTags = [...insufficientByTag.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, input.topInsufficientLimit)
        .map(([tagEpc, count]) => ({ tagEpc, count }));

      return {
        plazaId: input.plazaId,
        date: startOfDayWat.toISOString().slice(0, 10),
        totalEvents: rows.length,
        countsByStatus,
        revenueKobo,
        antiPassbackBlocked,
        topInsufficientTags,
        truncated: rows.length >= 5_000,
      };
    }),

  /**
   * Lane-event history for one tag (operator/admin/reviewer, or the owner of
   * the wallet the tag is linked to).
   */
  tagHistory: protectedProcedure
    .input(z.object({
      tagEpc: z
        .string()
        .trim()
        .transform((v) => v.toUpperCase())
        .refine((v) => /^[0-9A-F]{24}$/.test(v), { message: "Invalid EPC-96 identifier" }),
      page: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(100).default(50),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [tag] = await db
        .select()
        .from(rfidTags)
        .where(eq(rfidTags.tagEpc, input.tagEpc))
        .limit(1);
      if (!tag) throw new TRPCError({ code: "NOT_FOUND", message: "Tag not found" });

      // Owner check for non-staff callers.
      if (!REVIEW_ROLES.includes(ctx.user.role)) {
        if (tag.walletId == null) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Not the tag owner" });
        }
        const [wallet] = await db
          .select({ userId: walletAccounts.userId })
          .from(walletAccounts)
          .where(eq(walletAccounts.id, tag.walletId))
          .limit(1);
        if (wallet?.userId !== ctx.user.id) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Not the tag owner" });
        }
      }

      const rows = await db
        .select()
        .from(laneEvents)
        .where(eq(laneEvents.tagEpc, input.tagEpc))
        .orderBy(desc(laneEvents.occurredAt))
        .limit(input.limit)
        .offset((input.page - 1) * input.limit);

      return { tagEpc: input.tagEpc, events: rows, page: input.page, limit: input.limit };
    }),
});

export { laneEventInputSchema };
