/**
 * USSD Router — *346# Session Handler
 * =====================================
 * Handles Africa's Talking USSD session callbacks and maintains session state
 * in the database. The AT USSD gateway POSTs to /api/ussd/session on each
 * user input. This router also exposes a tRPC procedure for the simulator UI.
 *
 * Africa's Talking USSD flow:
 *   AT Gateway → POST /api/ussd/session
 *   Body: { sessionId, serviceCode, phoneNumber, text }
 *   Response: "CON <menu text>" (continue) or "END <final text>" (terminate)
 *
 * Session state machine:
 *   idle → main_menu → check_balance / topup / mini_statement / register / status
 */

import { z } from "zod";
import { publicProcedure, protectedProcedure, router } from "../_core/trpc.js";
import { TRPCError } from "@trpc/server";
import { getDb, getOrCreateWalletAccount, getWalletTransactions } from "../db.js";
import { ENV } from "../_core/env.js";

// ── USSD session state ────────────────────────────────────────────────────────

type UssdScreen =
  | "main_menu"
  | "check_balance"
  | "topup_menu"
  | "topup_amount"
  | "topup_confirm"
  | "mini_statement"
  | "register_vehicle"
  | "register_plate"
  | "register_confirm"
  | "app_status"
  | "app_status_result"
  | "session_end";

interface UssdSessionState {
  screen: UssdScreen;
  phoneNumber: string;
  userId?: string;
  topupAmount?: number;
  vehiclePlate?: string;
  statusRef?: string;
  createdAt: number;
  lastActivity: number;
}

// In-memory session store (TTL 5 minutes — AT sessions are short-lived)
const SESSION_TTL_MS = 5 * 60 * 1000;
const sessionStore = new Map<string, UssdSessionState>();

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of Array.from(sessionStore.entries())) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      sessionStore.delete(id);
    }
  }
}

function getOrCreateSession(sessionId: string, phoneNumber: string): UssdSessionState {
  cleanExpiredSessions();
  let session = sessionStore.get(sessionId);
  if (!session) {
    session = {
      screen: "main_menu",
      phoneNumber,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    sessionStore.set(sessionId, session);
  }
  session.lastActivity = Date.now();
  return session;
}

// ── USSD response builder ─────────────────────────────────────────────────────

function con(text: string): string {
  return `CON ${text}`;
}

function end(text: string): string {
  return `END ${text}`;
}

// ── DB persistence helpers ──────────────────────────────────────────────────

/**
 * Upsert a ussd_sessions row when a session starts (first interaction).
 * Fire-and-forget — never throws so it cannot break the USSD response.
 */
async function persistUssdSessionStart(
  sessionId: string,
  phoneNumber: string,
  serviceCode: string,
  isNew: boolean,
): Promise<void> {
  if (!isNew) return;
  try {
    const db = await getDb();
    if (!db) return;
    const { ussdSessions } = await import("../../drizzle/schema.js");
    const countryCode = phoneNumber.startsWith("+234") ? "NG" : phoneNumber.startsWith("+1") ? "US" : "XX";
    await db.insert(ussdSessions).values({
      sessionId,
      phoneNumber,
      serviceCode,
      countryCode,
      completed: false,
      interactionCount: 0,
      startedAt: new Date(),
      createdAt: new Date(),
    }).onConflictDoNothing();
  } catch (err) {
    console.warn("[USSD] Failed to persist session start:", err);
  }
}

/**
 * Update the ussd_sessions row when a session ends (END response sent).
 * Marks completed, records duration and menuPath.
 * Fire-and-forget — never throws.
 */
async function persistUssdSessionEnd(
  sessionId: string,
  menuPath: string,
  interactionCount: number,
  startedAt: number,
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const { ussdSessions } = await import("../../drizzle/schema.js");
    const { eq } = await import("drizzle-orm");
    const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
    await db.update(ussdSessions)
      .set({
        completed: true,
        menuPath,
        interactionCount,
        durationSeconds,
        endedAt: new Date(),
      })
      .where(eq(ussdSessions.sessionId, sessionId));
  } catch (err) {
    console.warn("[USSD] Failed to persist session end:", err);
  }
}

/**
 * Increment the interactionCount on each CON response (mid-session).
 * Fire-and-forget — never throws.
 */
async function persistUssdSessionInteraction(
  sessionId: string,
  interactionCount: number,
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const { ussdSessions } = await import("../../drizzle/schema.js");
    const { eq } = await import("drizzle-orm");
    await db.update(ussdSessions)
      .set({ interactionCount })
      .where(eq(ussdSessions.sessionId, sessionId));
  } catch (err) {
    console.warn("[USSD] Failed to update interaction count:", err);
  }
}

// ── Main USSD session processor ───────────────────────────────────────────────

export async function processUssdInput(
  sessionId: string,
  phoneNumber: string,
  text: string,
  userId?: string,
  serviceCode = "*346#",
): Promise<string> {
  const wasNew = !sessionStore.has(sessionId);
  const session = getOrCreateSession(sessionId, phoneNumber);
  if (userId) session.userId = userId;

  // Persist session start (fire-and-forget, only on first interaction)
  if (wasNew) {
    void persistUssdSessionStart(sessionId, phoneNumber, serviceCode, wasNew);
  }

  // Track interaction count on the in-memory session
  const interactionIndex = ((session as UssdSessionState & { _interactions?: number })._interactions ?? 0) + 1;
  (session as UssdSessionState & { _interactions?: number })._interactions = interactionIndex;

  // text is the full chain of inputs separated by '*'
  const inputs = text ? text.split("*") : [];
  const lastInput = inputs[inputs.length - 1] ?? "";

  // Determine current screen from input depth
  const depth = inputs.filter(i => i !== "").length;

  // ── Root menu (depth 0) ───────────────────────────────────────────────────
  // Only return main menu when text is empty (session start).
  // The full accumulated text string drives depth — do NOT check session.screen here.
  if (depth === 0) {
    session.screen = "main_menu";
    return con(
      "NigerianPass *346#\n" +
      "1. Check Balance\n" +
      "2. Top Up Wallet\n" +
      "3. Mini Statement\n" +
      "4. Register Vehicle\n" +
      "5. App Status\n" +
      "0. Exit"
    );
  }

  const rootChoice = inputs[0];

  // ── 1. Check Balance ──────────────────────────────────────────────────────
  if (rootChoice === "1") {
    if (session.userId) {
      try {
        const wallet = await getOrCreateWalletAccount(parseInt(session.userId, 10));
        const balanceNaira = wallet.balanceKobo / 100;
        const tier = balanceNaira >= 50000 ? "Elite" : balanceNaira >= 10000 ? "Premium" : "Standard";
        const available = balanceNaira.toLocaleString("en-NG");
        const fareCap = tier === "Standard" ? "₦700/day" : tier === "Premium" ? "₦1,400/day" : "₦2,100/day";
        return end(
          `NigerianPass Balance\n\n` +
          `Available: ₦${available}\n` +
          `Tier: ${tier}\n` +
          `Fare Cap: ${fareCap}\n\n` +
          `Dial *346# to continue`
        );
      } catch {
        return end("Balance unavailable.\nPlease try again later.");
      }
    }
    return end(
      "NigerianPass Balance\n\n" +
      "Please register at\nnigerianpass.ng to\nlink your phone number."
    );
  }

  // ── 2. Top Up Wallet ──────────────────────────────────────────────────────
  if (rootChoice === "2") {
    if (depth === 1) {
      session.screen = "topup_menu";
      return con(
        "Top Up Wallet\n\n" +
        "Enter amount (₦):\n" +
        "Min: ₦100\nMax: ₦10,000\n\n" +
        "0. Back"
      );
    }
    if (depth === 2) {
      if (lastInput === "0") {
        session.screen = "main_menu";
        return con(
          "NigerianPass *346#\n" +
          "1. Check Balance\n" +
          "2. Top Up Wallet\n" +
          "3. Mini Statement\n" +
          "4. Register Vehicle\n" +
          "5. App Status\n" +
          "0. Exit"
        );
      }
      const amount = parseInt(lastInput, 10);
      if (isNaN(amount) || amount < 100 || amount > 10000) {
        return end("Invalid amount.\nPlease enter between\n₦100 and ₦10,000.\n\nDial *346# to retry.");
      }
      session.topupAmount = amount;
      session.screen = "topup_confirm";
      return con(
        `Confirm Top-Up\n\n` +
        `Amount: ₦${amount.toLocaleString()}\n` +
        `Phone: ${phoneNumber}\n\n` +
        `1. Confirm\n2. Cancel`
      );
    }
    if (depth === 3) {
      if (lastInput === "1" && session.topupAmount) {
        // In production: initiate payment via Paystack USSD (*737# or similar)
        // For now: return a payment reference and instructions
        const ref = `USSD-${Date.now().toString(36).toUpperCase()}`;
        return end(
          `Top-Up Initiated\n\n` +
          `Ref: ${ref}\n` +
          `Amount: ₦${session.topupAmount.toLocaleString()}\n\n` +
          `Complete payment via\nyour bank's USSD code.\n` +
          `Credit within 30 mins.`
        );
      }
      return end("Top-up cancelled.\n\nDial *346# to continue.");
    }
  }

  // ── 3. Mini Statement ─────────────────────────────────────────────────────
  if (rootChoice === "3") {
    if (session.userId) {
      try {
        const wallet2 = await getOrCreateWalletAccount(parseInt(session.userId, 10));
        const txns = await getWalletTransactions(wallet2.id, 5);
        if (!txns.length) {
          return end("No transactions yet.\n\nDial *346# to continue.");
        }
        const lines = txns.map(t => {
          const sign = t.type === "topup" || t.type === "refund" ? "+" : "-";
          const amt = (Math.abs(t.amountKobo) / 100).toLocaleString("en-NG");
          const date = new Date(t.createdAt).toLocaleDateString("en-NG", { day: "2-digit", month: "2-digit" });
          const desc = (t.description ?? "Transaction").slice(0, 18);
          return `${date} ${sign}₦${amt}\n${desc}`;
        });
        return end(`Mini Statement\n\n${lines.join("\n---\n")}\n\nDial *346# for more`);
      } catch {
        return end("Statement unavailable.\nPlease try again later.");
      }
    }
    return end(
      "Mini Statement\n\n" +
      "Link your phone at\nnigerianpass.ng to\nview transactions."
    );
  }

  // ── 4. Register Vehicle ───────────────────────────────────────────────────
  if (rootChoice === "4") {
    if (depth === 1) {
      session.screen = "register_plate";
      return con("Register Vehicle\n\nEnter plate number:\n(e.g. ABC123XY)\n\n0. Back");
    }
    if (depth === 2) {
      if (lastInput === "0") {
        session.screen = "main_menu";
        return con(
          "NigerianPass *346#\n" +
          "1. Check Balance\n2. Top Up Wallet\n3. Mini Statement\n4. Register Vehicle\n5. App Status\n0. Exit"
        );
      }
      const plate = lastInput.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (plate.length < 5 || plate.length > 10) {
        return end("Invalid plate number.\nPlease try again.\n\nDial *346# to retry.");
      }
      session.vehiclePlate = plate;
      session.screen = "register_confirm";
      return con(
        `Confirm Registration\n\n` +
        `Plate: ${plate}\n` +
        `Phone: ${phoneNumber}\n\n` +
        `1. Confirm\n2. Cancel`
      );
    }
    if (depth === 3) {
      if (lastInput === "1" && session.vehiclePlate) {
        const ref = `VEH-${Date.now().toString(36).toUpperCase()}`;
        return end(
          `Vehicle Registered!\n\n` +
          `Plate: ${session.vehiclePlate}\n` +
          `Ref: ${ref}\n\n` +
          `Complete KYC at\nnigerianpass.ng\nfor full activation.`
        );
      }
      return end("Registration cancelled.\n\nDial *346# to continue.");
    }
  }

  // ── 5. Application Status ─────────────────────────────────────────────────
  if (rootChoice === "5") {
    if (depth === 1) {
      session.screen = "app_status";
      return con("Application Status\n\nEnter your reference\nnumber:\n\n0. Back");
    }
    if (depth === 2) {
      if (lastInput === "0") {
        session.screen = "main_menu";
        return con(
          "NigerianPass *346#\n" +
          "1. Check Balance\n2. Top Up Wallet\n3. Mini Statement\n4. Register Vehicle\n5. App Status\n0. Exit"
        );
      }
      const ref = lastInput.toUpperCase();
      // Try to look up the application in the DB
      try {
        const db = await getDb();
        const { kycApplications } = await import("../../drizzle/schema.js");
        const { eq } = await import("drizzle-orm");
        if (!db) return end(`Status unavailable.\nRef: ${ref}\n\nVisit nigerianpass.ng\nfor details.`);
        const apps = await db.select().from(kycApplications)
          .where(eq(kycApplications.referenceId, ref))
          .limit(1);
        if (apps.length === 0) {
          return end(`No application found\nfor ref: ${ref}\n\nDial *346# to retry.`);
        }
        const app = apps[0];
        const statusLabel: Record<string, string> = {
          pending: "Under Review",
          approved: "Approved",
          rejected: "Rejected",
          resubmit: "Resubmission Required",
        };
        const label = statusLabel[app.status ?? "pending"] ?? "Unknown";
        const submitted = new Date(app.createdAt ?? Date.now()).toLocaleDateString("en-NG");
        return end(
          `Application Status\n\n` +
          `Ref: ${ref}\n` +
          `Status: ${label}\n` +
          `Submitted: ${submitted}\n\n` +
          `Visit nigerianpass.ng\nfor full details.`
        );
      } catch {
        return end(`Status unavailable.\nRef: ${ref}\n\nVisit nigerianpass.ng\nfor details.`);
      }
    }
  }

  // ── 0. Exit ───────────────────────────────────────────────────────────────
  if (rootChoice === "0") {
    sessionStore.delete(sessionId);
    return end("Thank you for using\nNigerianPass.\n\nSafe travels!");
  }

  // ── Invalid option ────────────────────────────────────────────────────────
  return con(
    "Invalid option.\n\n" +
    "NigerianPass *346#\n" +
    "1. Check Balance\n" +
    "2. Top Up Wallet\n" +
    "3. Mini Statement\n" +
    "4. Register Vehicle\n" +
    "5. App Status\n" +
    "0. Exit"
  );
}

// ── tRPC Router ───────────────────────────────────────────────────────────────

export const ussdRouter = router({
  /**
   * Simulate a USSD session step from the browser simulator UI.
   * Accepts the full accumulated text string (same format as AT gateway).
   */
  session: publicProcedure
    .input(z.object({
      sessionId: z.string(),
      phoneNumber: z.string(),
      text: z.string(), // full accumulated input chain, e.g. "1" or "2*500*1"
      userId: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const response = await processUssdInput(
        input.sessionId,
        input.phoneNumber,
        input.text,
        input.userId
      );
      const isContinue = response.startsWith("CON ");
      const text = response.replace(/^(CON|END) /, "");
      return { text, isContinue, raw: response };
    }),

  /**
   * Get current session state (for debugging/admin).
   */
  getSessionState: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(({ input }) => {
      const session = sessionStore.get(input.sessionId);
      if (!session) return null;
      return {
        screen: session.screen,
        phoneNumber: session.phoneNumber,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
      };
    }),

  /**
   * Aggregate USSD session analytics for the Admin Analytics dashboard.
   * Queries the ussd_sessions DB table; falls back to live in-memory counts
   * when the DB is unavailable.
   */
  getSessionStats: protectedProcedure
    .input(z.object({
      /** Look-back window in days (default 30) */
      days: z.number().int().min(1).max(365).default(30),
    }))
    .query(async ({ input }) => {
      const db = await getDb();

      // Fallback: use in-memory session store when DB is unavailable
      if (!db) {
        const liveSessions = Array.from(sessionStore.values());
        return {
          totalSessions: liveSessions.length,
          completedSessions: 0,
          completionRate: 0,
          avgInteractions: 0,
          avgDurationSeconds: null as number | null,
          topMenuPaths: [] as Array<{ path: string; count: number }>,
          dailyCounts: [] as Array<{ date: string; total: number; completed: number }>,
          source: "live" as const,
        };
      }

      const { ussdSessions } = await import("../../drizzle/schema.js");
      const { sql: drizzleSql, gte, and } = await import("drizzle-orm");

      const since = new Date();
      since.setDate(since.getDate() - input.days);

      try {
        // Aggregate totals
        const [totals] = await db
          .select({
            total: drizzleSql<number>`count(*)::int`,
            completed: drizzleSql<number>`count(*) filter (where ${ussdSessions.completed} = true)::int`,
            avgInteractions: drizzleSql<number>`round(avg(${ussdSessions.interactionCount}), 1)::float`,
            avgDuration: drizzleSql<number | null>`round(avg(${ussdSessions.durationSeconds}), 0)::int`,
          })
          .from(ussdSessions)
          .where(gte(ussdSessions.startedAt, since));

        // Top menu paths (top 10)
        const topPaths = await db
          .select({
            path: ussdSessions.menuPath,
            count: drizzleSql<number>`count(*)::int`,
          })
          .from(ussdSessions)
          .where(and(
            gte(ussdSessions.startedAt, since),
            drizzleSql`${ussdSessions.menuPath} is not null`,
          ))
          .groupBy(ussdSessions.menuPath)
          .orderBy(drizzleSql`count(*) desc`)
          .limit(10);

        // Daily counts (last N days)
        const dailyCounts = await db
          .select({
            date: drizzleSql<string>`date(${ussdSessions.startedAt})::text`,
            total: drizzleSql<number>`count(*)::int`,
            completed: drizzleSql<number>`count(*) filter (where ${ussdSessions.completed} = true)::int`,
          })
          .from(ussdSessions)
          .where(gte(ussdSessions.startedAt, since))
          .groupBy(drizzleSql`date(${ussdSessions.startedAt})`)
          .orderBy(drizzleSql`date(${ussdSessions.startedAt})`);

        const total = totals?.total ?? 0;
        const completed = totals?.completed ?? 0;

        return {
          totalSessions: total,
          completedSessions: completed,
          completionRate: total > 0 ? Math.round((completed / total) * 100) : 0,
          avgInteractions: totals?.avgInteractions ?? 0,
          avgDurationSeconds: totals?.avgDuration ?? null,
          topMenuPaths: topPaths
            .filter(p => p.path)
            .map(p => ({ path: p.path!, count: p.count })),
          dailyCounts: dailyCounts.map(d => ({
            date: d.date,
            total: d.total,
            completed: d.completed,
          })),
          source: "db" as const,
        };
      } catch {
        return {
          totalSessions: 0,
          completedSessions: 0,
          completionRate: 0,
          avgInteractions: 0,
          avgDurationSeconds: null as number | null,
          topMenuPaths: [] as Array<{ path: string; count: number }>,
          dailyCounts: [] as Array<{ date: string; total: number; completed: number }>,
          source: "db" as const,
        };
      }
    }),

  /**
   * Get full detail for a single USSD session by sessionId.
   * Returns the session record plus a parsed step-by-step replay sequence.
   * Admin only.
   */
  getSessionDetail: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const { ussdSessions } = await import("../../drizzle/schema.js");
      const { eq } = await import("drizzle-orm");

      const [session] = await db
        .select()
        .from(ussdSessions)
        .where(eq(ussdSessions.sessionId, input.sessionId))
        .limit(1);

      if (!session) throw new TRPCError({ code: "NOT_FOUND", message: "Session not found" });

      // Parse pipe-separated menu path into human-readable steps
      const MENU_LABELS: Record<string, string> = {
        "1": "Check Balance",
        "2": "Top Up Wallet",
        "3": "Mini Statement",
        "4": "Register Vehicle",
        "5": "App Status",
        "0": "Back / Exit",
      };

      const steps = session.menuPath
        ? session.menuPath.split("|").map((choice, idx) => ({
            step: idx + 1,
            input: choice,
            label: MENU_LABELS[choice] ?? `Option ${choice}`,
          }))
        : [];

      const durationMs =
        session.durationSeconds != null
          ? session.durationSeconds * 1000
          : session.endedAt && session.startedAt
            ? new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()
            : null;

      return {
        session,
        steps,
        durationMs,
        summary: {
          phone: session.phoneNumber,
          serviceCode: session.serviceCode,
          completed: session.completed,
          interactionCount: session.interactionCount,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
        },
      };
    }),

  getSessionList: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
      completed: z.boolean().optional(),
      phone: z.string().optional(),
      days: z.number().int().min(1).max(90).default(30),
    }))
    .query(async ({ input, ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
      }
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const { ussdSessions } = await import("../../drizzle/schema.js");
      const { gte, eq, and, desc, ilike } = await import("drizzle-orm");
      const since = new Date(Date.now() - input.days * 86_400_000);
      const conditions: ReturnType<typeof gte>[] = [gte(ussdSessions.startedAt, since)];
      if (input.completed !== undefined) conditions.push(eq(ussdSessions.completed, input.completed) as any);
      if (input.phone) conditions.push(ilike(ussdSessions.phoneNumber, `%${input.phone}%`) as any);
      const rows = await db
        .select()
        .from(ussdSessions)
        .where(and(...conditions))
        .orderBy(desc(ussdSessions.startedAt))
        .limit(input.limit)
        .offset(input.offset);
      return { sessions: rows, total: rows.length };
    }),
});
