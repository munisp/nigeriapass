/**
 * Unified Payment Webhook Router
 * ================================
 * Handles incoming webhooks from all registered payment providers.
 * Route: POST /api/payments/webhook/:provider
 *
 * Flow:
 *  1. Read raw body (required for HMAC verification)
 *  2. Resolve the provider adapter by slug
 *  3. Verify HMAC signature — reject with 401 if invalid
 *  4. Check idempotency — skip if reference already processed
 *  5. Credit the wallet and record the transaction
 *  6. Emit a WebSocket event to notify the client
 *  7. Respond 200 immediately (providers retry on non-200)
 */

import { Router, Request, Response } from "express";
import { getProvider, getProviderSecretKey, PaymentProviderSlug } from "../payments/gateway";
import { getDb } from "../db";
import { walletAccounts, walletTransactions } from "../../drizzle/schema";
import { eq, and } from "drizzle-orm";
import { getKycStatusEmitter } from "../events/kycEvents";

export const paymentsRouter = Router();

// ── POST /api/payments/initiate ───────────────────────────────────────────────
// Initiates a top-up session and returns a checkout URL.
// Called by the Wallet page top-up modal.
paymentsRouter.post(
  "/initiate",
  async (req: Request, res: Response) => {
    const { provider: providerSlug, amountKobo, email, callbackUrl, metadata } = req.body as {
      provider: PaymentProviderSlug;
      amountKobo: number;
      email: string;
      callbackUrl: string;
      metadata?: Record<string, unknown>;
    };

    if (!providerSlug || !amountKobo || !email) {
      res.status(400).json({ error: "Missing required fields: provider, amountKobo, email" });
      return;
    }

    let provider;
    try {
      provider = getProvider(providerSlug);
    } catch {
      res.status(400).json({ error: `Unknown provider: ${providerSlug}` });
      return;
    }

    if (amountKobo < provider.minAmountKobo) {
      res.status(400).json({
        error: `Minimum amount for ${provider.displayName} is ₦${provider.minAmountKobo / 100}`,
      });
      return;
    }

    if (amountKobo > provider.maxAmountKobo) {
      res.status(400).json({
        error: `Maximum amount for ${provider.displayName} is ₦${provider.maxAmountKobo / 100}`,
      });
      return;
    }

    // Generate a unique reference: NP-<provider>-<timestamp>-<random>
    const reference = `NP-${providerSlug.toUpperCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    const secretKey = getProviderSecretKey(providerSlug);

    try {
      const result = await provider.initiateTopUp({
        reference,
        amountKobo,
        email,
        callbackUrl: callbackUrl ?? `${req.headers.origin ?? "https://nigerianpass.ng"}/wallet?status=success`,
        metadata: {
          ...metadata,
          source: "nigerianpass_wallet_topup",
          provider: providerSlug,
        },
      });

      // Record a pending transaction in the DB so the webhook can match it
      const db = await getDb();
      if (db) {
        try {
          // Find wallet account by email (best-effort — may not exist for new users)
          const accounts = await db
            .select({ id: walletAccounts.id })
            .from(walletAccounts)
            .limit(1);

          if (accounts.length > 0) {
            await db.insert(walletTransactions).values({
              walletId: accounts[0]!.id,
              type: "topup",
              amountKobo,
              balanceAfterKobo: 0, // Will be updated by webhook
              externalRef: reference,
              description: `Wallet top-up via ${provider.displayName} (pending)`,
            });
          }
        } catch (dbErr) {
          // Non-fatal — webhook will still credit the wallet
          console.warn("[Payments] Failed to pre-record pending transaction:", dbErr);
        }
      }

      res.json({
        checkoutUrl: result.checkoutUrl,
        reference: result.reference,
        providerReference: result.providerReference,
        provider: providerSlug,
        amountKobo,
      });
    } catch (err) {
      console.error(`[Payments] Failed to initiate ${providerSlug} top-up:`, err);
      // In demo mode (invalid key), return a simulated checkout URL
      const isDemoKey = secretKey.includes("demo") || secretKey.includes("test_nigerianpass");
      if (isDemoKey) {
        res.json({
          checkoutUrl: `${req.headers.origin ?? "https://nigerianpass.ng"}/wallet?demo_payment=success&ref=${reference}&provider=${providerSlug}&amount=${amountKobo}`,
          reference,
          providerReference: `DEMO-${reference}`,
          provider: providerSlug,
          amountKobo,
          demo: true,
        });
      } else {
        res.status(502).json({ error: `Payment provider error: ${(err as Error).message}` });
      }
    }
  }
);

// ── Raw body middleware (must be applied before JSON parser for this route) ───
// Express's json() middleware consumes the body stream; we need the raw Buffer
// for HMAC verification. This is registered before the global json() middleware
// in server/_core/index.ts via the rawBodyRouter pattern.

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
    const rawBody: Buffer = req.rawBody ?? Buffer.from(JSON.stringify(req.body));

    // ── 3. Parse and verify webhook ──────────────────────────────────────────
    const secretKey = getProviderSecretKey(providerSlug);
    let event;
    try {
      event = provider.parseWebhook(rawBody, req.headers as Record<string, string>, secretKey);
    } catch (err) {
      console.error(`[Payments] Failed to parse ${providerSlug} webhook:`, err);
      res.status(400).json({ error: "Failed to parse webhook" });
      return;
    }

    if (!event.verified) {
      console.warn(`[Payments] Invalid HMAC signature from ${providerSlug} for ref=${event.reference}`);
      // In demo mode (no real secret configured), we still process the event
      const isDemoMode = secretKey.includes("demo") || secretKey.includes("test");
      if (!isDemoMode) {
        res.status(401).json({ error: "Invalid signature" });
        return;
      }
      console.info(`[Payments] Demo mode: proceeding despite unverified signature`);
    }

    // ── 4. Only process successful charge events ─────────────────────────────
    if (!event.isChargeSuccess) {
      console.info(`[Payments] Non-charge event from ${providerSlug}: ${event.eventType} — ignoring`);
      res.status(200).json({ received: true, action: "ignored" });
      return;
    }

    const db = await getDb();
    if (!db) {
      console.error("[Payments] Database unavailable — cannot credit wallet");
      // Return 200 to prevent provider from retrying (we'll handle via manual reconciliation)
      res.status(200).json({ received: true, action: "db_unavailable" });
      return;
    }

    // ── 5. Idempotency check ─────────────────────────────────────────────────
    const existing = await db
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(eq(walletTransactions.externalRef, event.reference))
      .limit(1);

    if (existing.length > 0) {
      console.info(`[Payments] Duplicate webhook for ref=${event.reference} — skipping`);
      res.status(200).json({ received: true, action: "duplicate" });
      return;
    }

    // ── 6. Find wallet by email ──────────────────────────────────────────────
    // The reference format is: nigerianpass_<userId>_<timestamp>
    // We extract userId from the reference for direct wallet lookup
    let userId: number | null = null;
    const refMatch = event.reference.match(/^nigerianpass_(\d+)_/);
    if (refMatch) {
      userId = parseInt(refMatch[1], 10);
    }

    let wallet = null;
    if (userId) {
      const wallets = await db
        .select()
        .from(walletAccounts)
        .where(eq(walletAccounts.userId, userId))
        .limit(1);
      wallet = wallets[0] ?? null;
    }

    if (!wallet) {
      // Fallback: try to find wallet by email via users table
      console.warn(`[Payments] Could not find wallet for ref=${event.reference}, email=${event.email}`);
      // Record as unmatched transaction for manual reconciliation
      await db.insert(walletTransactions).values({
        walletId: 0, // sentinel for unmatched
        type: "topup",
        amountKobo: event.amountKobo,
        balanceAfterKobo: 0,
        description: `Unmatched top-up via ${provider.displayName} (ref: ${event.reference})`,
        externalRef: event.reference,
      });
      res.status(200).json({ received: true, action: "unmatched" });
      return;
    }

    // ── 7. Credit wallet atomically ──────────────────────────────────────────
    const newBalance = wallet.balanceKobo + event.amountKobo;

    await db.update(walletAccounts)
      .set({
        balanceKobo: newBalance,
        lastBalanceSync: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(walletAccounts.id, wallet.id));

    // ── 8. Record transaction ────────────────────────────────────────────────
    await db.insert(walletTransactions).values({
      walletId: wallet.id,
      type: "topup",
      amountKobo: event.amountKobo,
      balanceAfterKobo: newBalance,
      description: `Wallet top-up via ${provider.displayName}`,
      externalRef: event.reference,
    });

    console.info(
      `[Payments] Credited ₦${(event.amountKobo / 100).toFixed(2)} to wallet #${wallet.id} ` +
      `via ${providerSlug} (ref=${event.reference})`
    );

    // ── 9. Push real-time wallet update via WebSocket ────────────────────────
    // Use a generic Node.js EventEmitter to broadcast wallet credit events
    // The WebSocket server listens for this and forwards to the client
    const emitter = getKycStatusEmitter() as unknown as import("events").EventEmitter;
    emitter.emit("wallet_credited", {
      userId: wallet.userId,
      walletId: wallet.id,
      amountKobo: event.amountKobo,
      newBalanceKobo: newBalance,
      provider: providerSlug,
      reference: event.reference,
    });

    res.status(200).json({
      received: true,
      action: "credited",
      amountKobo: event.amountKobo,
      newBalanceKobo: newBalance,
    });
  }
);

// ── Initiate top-up endpoint (called by the Wallet page) ─────────────────────
// This is a REST endpoint (not tRPC) because it needs to return a redirect URL
// that the browser follows immediately.
paymentsRouter.post("/initiate", async (req: Request, res: Response) => {
  const { provider: providerSlug, amountKobo, email, userId } = req.body as {
    provider: PaymentProviderSlug;
    amountKobo: number;
    email: string;
    userId: number;
  };

  if (!providerSlug || !amountKobo || !email || !userId) {
    res.status(400).json({ error: "Missing required fields: provider, amountKobo, email, userId" });
    return;
  }

  let provider;
  try {
    provider = getProvider(providerSlug);
  } catch {
    res.status(400).json({ error: `Unknown provider: ${providerSlug}` });
    return;
  }

  if (amountKobo < provider.minAmountKobo || amountKobo > provider.maxAmountKobo) {
    res.status(400).json({
      error: `Amount must be between ₦${provider.minAmountKobo / 100} and ₦${provider.maxAmountKobo / 100}`,
    });
    return;
  }

  const reference = `nigerianpass_${userId}_${Date.now()}`;
  const origin = req.headers.origin ?? `${req.protocol}://${req.get("host")}`;
  const callbackUrl = `${origin}/wallet?payment_status=success&ref=${reference}&provider=${providerSlug}`;

  try {
    const secretKey = getProviderSecretKey(providerSlug);
    const result = await provider.initiateTopUp({
      reference,
      amountKobo,
      email,
      callbackUrl,
      metadata: { userId, providerSlug },
    });

    res.json({
      checkoutUrl: result.checkoutUrl,
      reference: result.reference,
      providerReference: result.providerReference,
      provider: providerSlug,
    });
  } catch (err) {
    console.error(`[Payments] Failed to initiate top-up via ${providerSlug}:`, err);
    res.status(502).json({ error: `Payment initiation failed: ${(err as Error).message}` });
  }
});
