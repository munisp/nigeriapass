/**
 * Wallet tRPC Router
 * ==================
 * Provides real PostgreSQL-backed wallet balance and transaction history
 * for authenticated users. Replaces the legacy REST gateway dependency
 * in the Wallet page.
 *
 * Procedures:
 *  - wallet.getBalance   — returns the user's wallet account (creates one if new)
 *  - wallet.getTransactions — paginated transaction history
 *  - wallet.getStats     — aggregate spend/credit stats for the last N days
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { walletAccounts, walletTransactions } from "../../drizzle/schema";
import { eq, desc, and, gte, sql } from "drizzle-orm";
import { getOrCreateWalletAccount, getWalletTransactions } from "../db";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { createHmac } from "crypto";
import { ENV } from "../_core/env";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Derive wallet tier from balance */
function getTier(balanceKobo: number): "basic" | "standard" | "premium" {
  if (balanceKobo >= 5_000_000) return "premium";   // ≥ ₦50,000
  if (balanceKobo >= 1_000_000) return "standard";  // ≥ ₦10,000
  return "basic";
}

/** Reset daily spend if last sync was a different calendar day (WAT = UTC+1) */
async function maybeResetDailySpend(
  db: ReturnType<typeof import("drizzle-orm/node-postgres").drizzle>,
  wallet: typeof walletAccounts.$inferSelect
): Promise<typeof walletAccounts.$inferSelect> {
  const nowWAT = new Date(Date.now() + 60 * 60 * 1000); // UTC+1
  const syncWAT = new Date(wallet.lastBalanceSync.getTime() + 60 * 60 * 1000);

  const today = nowWAT.toISOString().slice(0, 10);
  const syncDay = syncWAT.toISOString().slice(0, 10);

  if (today !== syncDay && wallet.dailySpentKobo > 0) {
    const updated = await db
      .update(walletAccounts)
      .set({ dailySpentKobo: 0, lastBalanceSync: new Date(), updatedAt: new Date() })
      .where(eq(walletAccounts.id, wallet.id))
      .returning();
    return updated[0] ?? wallet;
  }
  return wallet;
}

// ── Router ────────────────────────────────────────────────────────────────────

export const walletRouter = router({

  /**
   * Get (or create) the authenticated user's wallet balance.
   * Returns a shape compatible with the WalletBalance interface in client/src/lib/api.ts.
   */
  getBalance: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) {
      // Return a demo balance when the DB is unavailable (e.g. local dev without DB)
      return {
        account_id: "DEMO-WALLET",
        balance_kobo: 465_000,
        pending_kobo: 0,
        currency: "NGN",
        tier: "standard" as const,
        daily_cap_kobo: 500_000,
        daily_spent_kobo: 0,
        fare_cap_limit_kobo: 500_000,
        fare_cap_reset_date: new Date(Date.now() + 12 * 86_400_000).toISOString(),
        last_updated: new Date().toISOString(),
        is_demo: true,
      };
    }

    try {
      let wallet = await getOrCreateWalletAccount(ctx.user.id);
      wallet = await maybeResetDailySpend(db, wallet);

      return {
        account_id: wallet.tigerBeetleId,
        balance_kobo: wallet.balanceKobo,
        pending_kobo: 0,
        currency: "NGN",
        tier: getTier(wallet.balanceKobo),
        daily_cap_kobo: wallet.dailyCapKobo,
        daily_spent_kobo: wallet.dailySpentKobo,
        fare_cap_limit_kobo: wallet.dailyCapKobo,
        fare_cap_reset_date: (() => {
          const d = new Date();
          d.setUTCDate(d.getUTCDate() + 1);
          d.setUTCHours(23, 0, 0, 0); // midnight WAT
          return d.toISOString();
        })(),
        last_updated: wallet.lastBalanceSync.toISOString(),
        is_demo: false,
      };
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Failed to load wallet: ${(err as Error).message}`,
      });
    }
  }),

  /**
   * Paginated transaction history for the authenticated user's wallet.
   * Returns a shape compatible with the Transaction interface in client/src/lib/api.ts.
   */
  getTransactions: protectedProcedure
    .input(z.object({
      page: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(100).default(50),
      type: z.enum(["all", "topup", "toll_charge", "refund", "adjustment"]).default("all"),
      fromDays: z.number().int().min(0).max(365).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) {
        return { transactions: [], total: 0, page: input.page, is_demo: true };
      }

      try {
        const wallet = await getOrCreateWalletAccount(ctx.user.id);
        const offset = (input.page - 1) * input.limit;

        // Build WHERE conditions
        const conditions = [eq(walletTransactions.walletId, wallet.id)];
        if (input.type !== "all") {
          conditions.push(eq(walletTransactions.type, input.type));
        }
        if (input.fromDays) {
          const cutoff = new Date(Date.now() - input.fromDays * 86_400_000);
          conditions.push(gte(walletTransactions.createdAt, cutoff));
        }

        const whereClause = conditions.length > 1 ? and(...conditions) : conditions[0];

        const [rows, countRows] = await Promise.all([
          db.select().from(walletTransactions)
            .where(whereClause)
            .orderBy(desc(walletTransactions.createdAt))
            .limit(input.limit)
            .offset(offset),
          db.select({ total: sql<number>`count(*)::int` })
            .from(walletTransactions)
            .where(whereClause),
        ]);

        const total = countRows[0]?.total ?? 0;

        // Map DB rows to the client Transaction shape
        const transactions = rows.map(row => ({
          id: `TXN-${row.id}`,
          type: row.type as "topup" | "toll_charge" | "refund" | "adjustment",
          amount_kobo: row.amountKobo,
          direction: (row.type === "topup" || row.type === "refund" || row.type === "adjustment")
            ? "credit" as const
            : "debit" as const,
          description: row.description ?? row.type,
          reference: row.externalRef ?? `NP-${row.id}`,
          plaza: row.plazaId ?? undefined,
          vehicle_plate: undefined,
          status: "completed" as const,
          created_at: row.createdAt.toISOString(),
          balance_after_kobo: row.balanceAfterKobo,
        }));

        return { transactions, total, page: input.page, is_demo: false };
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to load transactions: ${(err as Error).message}`,
        });
      }
    }),

  /**
   * Aggregate wallet stats: total credited, total debited, transaction count
   * over the last N days.
   */
  getStats: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(365).default(30) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) {
        return { total_credited_kobo: 0, total_debited_kobo: 0, transaction_count: 0, is_demo: true };
      }

      try {
        const wallet = await getOrCreateWalletAccount(ctx.user.id);
        const cutoff = new Date(Date.now() - input.days * 86_400_000);

        const rows = await db
          .select({
            type: walletTransactions.type,
            total: sql<number>`sum(${walletTransactions.amountKobo})::bigint`,
            count: sql<number>`count(*)::int`,
          })
          .from(walletTransactions)
          .where(and(
            eq(walletTransactions.walletId, wallet.id),
            gte(walletTransactions.createdAt, cutoff),
          ))
          .groupBy(walletTransactions.type);

        let totalCreditedKobo = 0;
        let totalDebitedKobo = 0;
        let transactionCount = 0;

        for (const row of rows) {
          transactionCount += row.count;
          if (row.type === "topup" || row.type === "refund" || row.type === "adjustment") {
            totalCreditedKobo += Number(row.total);
          } else {
            totalDebitedKobo += Number(row.total);
          }
        }

        return {
          total_credited_kobo: totalCreditedKobo,
          total_debited_kobo: totalDebitedKobo,
          transaction_count: transactionCount,
          is_demo: false,
        };
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to load wallet stats: ${(err as Error).message}`,
        });
      }
    }),

  /**
   * Export transaction history as CSV.
   * Returns a CSV string with all transactions for the last N days.
   */
  exportTransactionsCsv: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(365).default(90) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const wallet = await getOrCreateWalletAccount(ctx.user.id);
      const cutoff = new Date(Date.now() - input.days * 86_400_000);

      const rows = await db
        .select()
        .from(walletTransactions)
        .where(and(
          eq(walletTransactions.walletId, wallet.id),
          gte(walletTransactions.createdAt, cutoff),
        ))
        .orderBy(desc(walletTransactions.createdAt));

      // Build CSV
      const header = "Date,Type,Amount (NGN),Reference,Description";
      const lines = rows.map(tx => {
        const date = new Date(tx.createdAt).toLocaleString("en-NG", { timeZone: "Africa/Lagos" });
        const amountNgn = (tx.amountKobo / 100).toFixed(2);
        const type = tx.type.replace("_", " ").toUpperCase();
        const ref = tx.externalRef ?? tx.id.toString();
        const desc = tx.description?.replace(/,/g, ";") ?? "";
        return `"${date}","${type}","${amountNgn}","${ref}","${desc}"`;
      });

      return {
        csv: [header, ...lines].join("\n"),
        filename: `nigerianpass-transactions-${new Date().toISOString().slice(0, 10)}.csv`,
        rowCount: rows.length,
      };
    }),

  /**
   * Get a single transaction receipt as a formatted PDF.
   * Returns base64-encoded PDF bytes, HMAC stamp, and metadata.
   */
  getTransactionReceipt: protectedProcedure
    .input(z.object({ transactionId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const wallet = await getOrCreateWalletAccount(ctx.user.id);
      const [tx] = await db
        .select()
        .from(walletTransactions)
        .where(and(
          eq(walletTransactions.id, input.transactionId),
          eq(walletTransactions.walletId, wallet.id),
        ))
        .limit(1);
      if (!tx) throw new TRPCError({ code: "NOT_FOUND", message: "Transaction not found" });

      // ── HMAC integrity stamp ──────────────────────────────────────────────────
      const hmacPayload = `${tx.id}:${tx.walletId}:${tx.amountKobo}:${tx.createdAt.toISOString()}`;
      const hmacStamp = createHmac("sha256", ENV.cookieSecret)
        .update(hmacPayload)
        .digest("hex")
        .slice(0, 32)
        .toUpperCase();

      // ── Build PDF ─────────────────────────────────────────────────────────────
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([420, 600]);
      const { width, height } = page.getSize();
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const fontReg  = await pdfDoc.embedFont(StandardFonts.Helvetica);

      const green = rgb(0.05, 0.55, 0.32);
      const dark  = rgb(0.10, 0.10, 0.10);
      const mid   = rgb(0.40, 0.40, 0.40);
      const light = rgb(0.85, 0.85, 0.85);

      // Header band
      page.drawRectangle({ x: 0, y: height - 80, width, height: 80, color: green });
      page.drawText("NigerianPass", { x: 24, y: height - 36, size: 22, font: fontBold, color: rgb(1, 1, 1) });
      page.drawText("TRANSACTION RECEIPT", { x: 24, y: height - 58, size: 9, font: fontReg, color: rgb(0.85, 1, 0.85) });

      const receiptNo = `NP-${String(tx.id).padStart(8, "0")}`;
      page.drawText(receiptNo, { x: width - 120, y: height - 44, size: 10, font: fontBold, color: rgb(1, 1, 1) });

      // Amount
      const amountNgn = (tx.amountKobo / 100).toFixed(2);
      const isCredit = tx.type === "topup" || tx.type === "refund" || tx.type === "adjustment";
      page.drawText(
        `${isCredit ? "+" : "-"}\u20a6${Number(amountNgn).toLocaleString("en-NG", { minimumFractionDigits: 2 })}`,
        { x: 24, y: height - 130, size: 32, font: fontBold, color: isCredit ? green : rgb(0.8, 0.1, 0.1) }
      );
      page.drawText(tx.type.replace("_", " ").toUpperCase(), { x: 24, y: height - 152, size: 10, font: fontReg, color: mid });

      // Divider
      page.drawLine({ start: { x: 24, y: height - 168 }, end: { x: width - 24, y: height - 168 }, thickness: 0.5, color: light });

      // Detail rows
      const rows: Array<[string, string]> = [
        ["Date",           new Date(tx.createdAt).toLocaleString("en-NG", { timeZone: "Africa/Lagos" })],
        ["Description",    tx.description ?? "\u2014"],
        ["Reference",      tx.externalRef ?? receiptNo],
        ["Plaza",          tx.plazaId ?? "\u2014"],
        ["Wallet ID",      `WLT-${String(tx.walletId).padStart(6, "0")}`],
        ["Transaction ID", String(tx.id)],
      ];

      let y = height - 196;
      for (const [label, value] of rows) {
        page.drawText(label,          { x: 24,  y, size: 9, font: fontReg,  color: mid  });
        page.drawText(value.slice(0, 52), { x: 160, y, size: 9, font: fontBold, color: dark });
        y -= 24;
        page.drawLine({ start: { x: 24, y: y + 12 }, end: { x: width - 24, y: y + 12 }, thickness: 0.3, color: light });
      }

      // HMAC stamp block
      y -= 16;
      page.drawRectangle({ x: 24, y: y - 28, width: width - 48, height: 44, color: rgb(0.97, 0.97, 0.97), borderColor: light, borderWidth: 0.5 });
      page.drawText("INTEGRITY STAMP",  { x: 32, y: y + 6,  size: 7,   font: fontBold, color: mid  });
      page.drawText(hmacStamp,          { x: 32, y: y - 14, size: 7.5, font: fontReg,  color: dark });

      // Footer
      page.drawLine({ start: { x: 24, y: 52 }, end: { x: width - 24, y: 52 }, thickness: 0.5, color: light });
      page.drawText("NigerianPass Electronic Toll Collection System",                    { x: 24, y: 36, size: 7.5, font: fontReg, color: mid });
      page.drawText("This receipt is computer-generated and valid without signature.",   { x: 24, y: 22, size: 7,   font: fontReg, color: mid });

      const pdfBytes = await pdfDoc.save();
      const pdfBase64 = Buffer.from(pdfBytes).toString("base64");

      return {
        id: tx.id,
        receiptNo,
        type: tx.type,
        amountKobo: tx.amountKobo,
        amountNgn,
        description: tx.description ?? "",
        externalRef: tx.externalRef ?? "",
        createdAt: tx.createdAt,
        plazaId: tx.plazaId ?? null,
        walletId: tx.walletId,
        hmacStamp,
        pdfBase64,
        pdfFilename: `NigerianPass-Receipt-${receiptNo}.pdf`,
      };
    }),

  /**
   * Initiate a wallet top-up via Paystack or Flutterwave.
   * Returns a checkout URL to redirect the user to the payment provider.
   * Uses the authenticated user's email — no hardcoded placeholder.
   */
  initiateTopup: protectedProcedure
    .input(z.object({
      amountNgn: z.number().min(100).max(1_000_000),
      provider: z.enum(["paystack", "flutterwave"]).default("paystack"),
      callbackUrl: z.string().url().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const amountKobo = Math.round(input.amountNgn * 100);
      const userEmail = ctx.user.email ?? `user-${ctx.user.id}@nigerianpass.ng`;
      const callbackUrl = input.callbackUrl ?? `${ENV.oAuthServerUrl?.replace("/api/oauth", "") ?? "https://nigerianpass.ng"}/wallet?status=success`;

      // Use the existing payment gateway
      const { getProvider, getProviderSecretKey } = await import("../payments/gateway");
      const provider = getProvider(input.provider);
      const reference = `NP-TOPUP-${ctx.user.id}-${Date.now()}`;
      const result = await provider.initiateTopUp({
        reference,
        amountKobo,
        email: userEmail,
        callbackUrl,
        metadata: {
          source: "wallet_topup_trpc",
          userId: ctx.user.id,
          walletTopup: true,
        },
      });

      return {
        checkoutUrl: result.checkoutUrl,
        reference: result.reference,
        provider: input.provider,
        amountKobo,
        amountNgn: input.amountNgn,
      };
    }),

  /**
   * Verify a completed top-up payment by reference.
   * Called from the /wallet/confirm callback page after Paystack redirects back.
   * Idempotent — safe to call multiple times for the same reference.
   */
  verifyTopup: protectedProcedure
    .input(z.object({
      reference: z.string().min(1),
      provider: z.enum(["paystack", "flutterwave"]).default("paystack"),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // Check if already credited (idempotency)
      const existing = await db
        .select({ id: walletTransactions.id, amountKobo: walletTransactions.amountKobo })
        .from(walletTransactions)
        .where(eq(walletTransactions.externalRef, input.reference))
        .limit(1);

      if (existing.length > 0) {
        return { status: "already_credited", amountKobo: existing[0]!.amountKobo, reference: input.reference };
      }

      // Verify with provider
      const { getProvider, getProviderSecretKey } = await import("../payments/gateway");
      const provider = getProvider(input.provider);
      const secretKey = getProviderSecretKey(input.provider);
      const event = await provider.verifyTransaction(input.reference, secretKey);

      if (!event.success) {
        return { status: "failed", amountKobo: 0, reference: input.reference };
      }

      // Credit the wallet
      const wallet = await getOrCreateWalletAccount(ctx.user.id);
      await db.update(walletAccounts)
        .set({
          balanceKobo: sql`${walletAccounts.balanceKobo} + ${event.amountKobo}`,
          updatedAt: new Date(),
        })
        .where(eq(walletAccounts.id, wallet.id));

      await db.insert(walletTransactions).values({
        walletId: wallet.id,
        type: "topup",
        amountKobo: event.amountKobo,
        balanceAfterKobo: (wallet.balanceKobo ?? 0) + event.amountKobo,
        description: `Wallet top-up via ${input.provider.charAt(0).toUpperCase() + input.provider.slice(1)}`,
        externalRef: input.reference,
      });

      return { status: "credited", amountKobo: event.amountKobo, reference: input.reference };
    }),
});
