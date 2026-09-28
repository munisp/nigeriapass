/**
 * Unified Payment Webhook Router
 * ================================
 * Handles incoming webhooks from all registered payment providers.
 * Route: POST /api/payments/webhook/:provider
 *
 * Flow:
 *  1. Read raw body (captured by express.json({verify}) BEFORE global parsing
 *     in server/_core/index.ts — required for correct HMAC verification)
 *  2. Resolve the provider adapter by slug
 *  3. Verify HMAC signature — reject with 401 if invalid (NO demo bypass)
 *  4. Credit the wallet atomically (idempotent via UNIQUE(external_ref)
 *     + INSERT ... ON CONFLICT DO NOTHING + atomic balance increment)
 *  5. Emit a WebSocket event to notify the client
 *  6. Respond 200 immediately (providers retry on non-200)
 *
 * The legacy POST /api/payments/initiate handlers were removed (audit v13,
 * P0-5). Top-ups are initiated exclusively via trpc.wallet.initiateTopup.
 */

import { Router, Request, Response } from "express";
import { getProvider, getProviderSecretKey, PaymentProviderSlug } from "../payments/gateway";
import { parsePaymentReference } from "../payments/reference";
import { getDb, creditWalletAtomic } from "../db";
import { disputes } from "../../drizzle/schema";
import { getKycStatusEmitter } from "../events/kycEvents";
import { writeAuditLog } from "../_core/audit";

export const paymentsRouter = Router();

paymentsRouter.post(
  "/webhook/:provider",
  async (req: Request & { rawBody?: Buffer }, res: Response) => {
    const providerSlug = req.params.provider as PaymentProviderSlug;

    // ── 1. Resolve provider ──────────────────────────────────────────────────
    let provider;
    try {
      provider = getProvider(providerSlug);
    } catch {
      res.status(400).json({ error: `Unknown provider: ${providerSlug}` });
      return;
    }

    // ── 2. Get raw body ──────────────────────────────────────────────────────
    // Captured by the express.json({ verify }) middleware registered BEFORE the
    // global body parser in server/_core/index.ts. If it is missing we cannot
    // verify the HMAC over the exact provider payload, so we fail closed.
    const rawBody: Buffer | undefined = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
      console.error(`[Payments] Missing raw body for ${providerSlug} webhook — cannot verify HMAC`);
      res.status(400).json({ error: "Missing raw body" });
      return;
    }

    // ── 3. Parse and verify webhook ──────────────────────────────────────────
    let secretKey: string;
    try {
      secretKey = getProviderSecretKey(providerSlug);
    } catch (err) {
      console.error(`[Payments] ${providerSlug} secret not configured:`, (err as Error).message);
      res.status(503).json({ error: "Payment provider not configured" });
      return;
    }

    let event;
    try {
      event = provider.parseWebhook(rawBody, req.headers as Record<string, string>, secretKey);
    } catch (err) {
      console.error(`[Payments] Failed to parse ${providerSlug} webhook:`, err);
      res.status(400).json({ error: "Failed to parse webhook" });
      return;
    }

    if (!event.verified) {
      // Fail closed — there is deliberately NO demo-mode bypass here.
      console.warn(`[Payments] Invalid HMAC signature from ${providerSlug} for ref=${event.reference}`);
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    // ── 4. Dispute / chargeback events — freeze funds ────────────────────────
    const eventType = event.eventType?.toLowerCase() ?? "";
    if (eventType.includes("dispute") || eventType.includes("chargeback")) {
      try {
        const db = await getDb();
        if (db) {
          const parsed = parsePaymentReference(event.reference);
          await db.insert(disputes).values({
            disputeRef: event.providerReference || event.reference || `dsp-${Date.now()}`,
            provider: providerSlug,
            paymentRef: event.reference,
            amountKobo: event.amountKobo || null,
            fundsFrozen: true,
            status: "open",
            rawPayload: event.rawPayload,
          }).onConflictDoNothing();
          console.warn(`[Payments] Dispute opened for ref=${event.reference} (user=${parsed?.userId ?? "unknown"}) — funds flagged frozen`);
        }
      } catch (err) {
        console.error("[Payments] Failed to record dispute:", err);
      }
      res.status(200).json({ received: true, action: "dispute_recorded" });
      return;
    }

    // ── 5. Only process successful charge events ─────────────────────────────
    if (!event.isChargeSuccess) {
      console.info(`[Payments] Non-charge event from ${providerSlug}: ${event.eventType} — ignoring`);
      res.status(200).json({ received: true, action: "ignored" });
      return;
    }

    const db = await getDb();
    if (!db) {
      console.error("[Payments] Database unavailable — cannot credit wallet");
      // Return 503 so the provider retries instead of silently dropping funds.
      res.status(503).json({ error: "db_unavailable" });
      return;
    }

    // ── 6. Resolve the wallet from the unified payment reference ─────────────
    const parsed = parsePaymentReference(event.reference);
    if (!parsed) {
      console.warn(`[Payments] Unparseable reference ${event.reference} — recorded for manual reconciliation`);
      res.status(200).json({ received: true, action: "unmatched" });
      return;
    }

    // ── 7. Credit wallet atomically + idempotently ───────────────────────────
    // creditWalletAtomic performs, inside one DB transaction:
    //   INSERT ... ON CONFLICT (external_ref) DO NOTHING  (idempotency guard)
    //   UPDATE wallet_accounts SET balance_kobo = balance_kobo + $amt
    // so webhook replays and concurrent deliveries cannot double-credit.
    const outcome = await creditWalletAtomic({
      userId: parsed.userId,
      amountKobo: event.amountKobo,
      externalRef: event.reference,
      type: "topup",
      description: `Wallet top-up via ${provider.displayName}`,
    });

    if (outcome.status === "duplicate") {
      console.info(`[Payments] Duplicate webhook for ref=${event.reference} — skipping`);
      res.status(200).json({ received: true, action: "duplicate" });
      return;
    }
    if (outcome.status === "no_wallet") {
      console.warn(`[Payments] No wallet for user ${parsed.userId} (ref=${event.reference}) — manual reconciliation required`);
      res.status(200).json({ received: true, action: "unmatched" });
      return;
    }

    console.info(
      `[Payments] Credited ₦${(event.amountKobo / 100).toFixed(2)} to wallet #${outcome.walletId} ` +
      `via ${providerSlug} (ref=${event.reference})`
    );

    // ── 8. Audit + push real-time wallet update via WebSocket ────────────────
    void writeAuditLog({
      actorUserId: null,
      action: "wallet.credit",
      entity: "wallet",
      entityId: String(outcome.walletId),
      diff: {
        amountKobo: event.amountKobo,
        newBalanceKobo: outcome.newBalanceKobo,
        provider: providerSlug,
        reference: event.reference,
        source: "webhook",
      },
    });

    const emitter = getKycStatusEmitter() as unknown as import("events").EventEmitter;
    emitter.emit("wallet_credited", {
      userId: parsed.userId,
      walletId: outcome.walletId,
      amountKobo: event.amountKobo,
      newBalanceKobo: outcome.newBalanceKobo,
      provider: providerSlug,
      reference: event.reference,
    });

    res.status(200).json({
      received: true,
      action: "credited",
      amountKobo: event.amountKobo,
      newBalanceKobo: outcome.newBalanceKobo,
    });
  }
);
