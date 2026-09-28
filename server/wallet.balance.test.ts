/**
 * Wallet Balance & Credit-Detection Tests
 * =========================================
 * Tests the wallet.getBalance tRPC procedure and the credit-detection
 * polling logic used by the /wallet/confirm page:
 *
 *  1. getBalance returns a demo balance when the DB is unavailable
 *  2. getBalance returns the real PostgreSQL-backed balance when DB is available
 *  3. getBalance creates a new wallet account for first-time users
 *  4. Credit-detection: balance increases between two successive calls
 *     → the second call returns a higher balance_kobo (simulates reconciliation credit)
 *  5. Credit-detection: balance unchanged between two calls → returns same value
 *  6. getTier returns "basic" / "standard" / "premium" based on balance
 *  7. getBalance propagates DB errors as INTERNAL_SERVER_ERROR
 *
 * All DB calls are mocked — no live PostgreSQL required.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TrpcContext } from "./_core/context";

// ── Shared in-memory wallet store ─────────────────────────────────────────────
// Defined outside vi.hoisted so it persists across beforeEach cycles.
// Tests mutate this directly via setWalletBalance().

const walletStore: Record<number, {
  id: number;
  userId: number;
  tigerBeetleId: string;
  balanceKobo: number;
  pendingKobo: number;
  dailyCapKobo: number;
  dailySpentKobo: number;
  lastBalanceSync: Date;
  createdAt: Date;
  updatedAt: Date;
}> = {};

function makeWallet(userId: number, balanceKobo = 0) {
  return {
    id: userId * 10,
    userId,
    tigerBeetleId: `TB-${userId}`,
    balanceKobo,
    pendingKobo: 0,
    dailyCapKobo: 500_000,
    dailySpentKobo: 0,
    lastBalanceSync: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function setWalletBalance(userId: number, balanceKobo: number) {
  if (!walletStore[userId]) {
    walletStore[userId] = makeWallet(userId, balanceKobo);
  } else {
    walletStore[userId]!.balanceKobo = balanceKobo;
  }
}

// ── Mock the DB module ────────────────────────────────────────────────────────

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    ...actual,
    getDb: vi.fn().mockResolvedValue({
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
    getOrCreateWalletAccount: vi.fn(async (userId: number) => {
      if (!walletStore[userId]) {
        walletStore[userId] = makeWallet(userId);
      }
      return walletStore[userId]!;
    }),
    getWalletTransactions: vi.fn().mockResolvedValue([]),
  };
});

// ── Import router AFTER mocks ─────────────────────────────────────────────────

import { appRouter } from "./routers";

// ── Helpers ───────────────────────────────────────────────────────────────────

function createWalletContext(userId = 42): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `user:${userId}`,
      name: `Test User ${userId}`,
      email: `user${userId}@test.com`,
      role: "user",
      loginMethod: "oauth",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: {
      protocol: "https",
      headers: { "x-forwarded-for": "127.0.0.1" },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as TrpcContext["req"],
    res: {
      cookie: vi.fn(),
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

function getWalletCaller(userId = 42) {
  return appRouter.createCaller(createWalletContext(userId));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("wallet.getBalance", () => {
  beforeEach(() => {
    // Clear the wallet store between tests to avoid cross-test pollution
    for (const key of Object.keys(walletStore)) {
      delete walletStore[Number(key)];
    }
  });

  it("returns a demo balance when DB is unavailable", async () => {
    const { getDb } = await import("./db");
    vi.mocked(getDb).mockResolvedValueOnce(null as never);

    const balance = await getWalletCaller(1).wallet.getBalance();

    expect(balance.is_demo).toBe(true);
    expect(balance.account_id).toBe("DEMO-WALLET");
    expect(balance.balance_kobo).toBeGreaterThan(0);
    expect(balance.currency).toBe("NGN");
  });

  it("returns the real DB-backed balance for an existing user", async () => {
    const USER_ID = 42;
    setWalletBalance(USER_ID, 250_000);

    const balance = await getWalletCaller(USER_ID).wallet.getBalance();

    expect(balance.is_demo).toBe(false);
    expect(balance.balance_kobo).toBe(250_000);
    expect(balance.account_id).toBe(`TB-${USER_ID}`);
    expect(balance.currency).toBe("NGN");
  });

  it("creates a new wallet account for a first-time user (balance = 0)", async () => {
    const NEW_USER_ID = 999;
    const balance = await getWalletCaller(NEW_USER_ID).wallet.getBalance();

    expect(balance.is_demo).toBe(false);
    expect(balance.balance_kobo).toBe(0);
    expect(balance.account_id).toBe(`TB-${NEW_USER_ID}`);
  });

  it("returns tier=basic for balance < ₦10,000 (1,000,000 kobo)", async () => {
    const USER_ID = 43;
    setWalletBalance(USER_ID, 500_000); // ₦5,000

    const balance = await getWalletCaller(USER_ID).wallet.getBalance();
    expect(balance.tier).toBe("basic");
  });

  it("returns tier=standard for balance ≥ ₦10,000 (1,000,000 kobo)", async () => {
    const USER_ID = 44;
    setWalletBalance(USER_ID, 1_500_000); // ₦15,000

    const balance = await getWalletCaller(USER_ID).wallet.getBalance();
    expect(balance.tier).toBe("standard");
  });

  it("returns tier=premium for balance ≥ ₦50,000 (5,000,000 kobo)", async () => {
    const USER_ID = 45;
    setWalletBalance(USER_ID, 6_000_000); // ₦60,000

    const balance = await getWalletCaller(USER_ID).wallet.getBalance();
    expect(balance.tier).toBe("premium");
  });

  it("propagates DB errors as INTERNAL_SERVER_ERROR", async () => {
    const { getOrCreateWalletAccount } = await import("./db");
    vi.mocked(getOrCreateWalletAccount).mockRejectedValueOnce(
      new Error("PG connection lost")
    );

    await expect(getWalletCaller(42).wallet.getBalance()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: expect.stringContaining("PG connection lost"),
    });
  });
});

// ── Credit-detection polling simulation ──────────────────────────────────────

describe("wallet credit-detection (polling simulation)", () => {
  beforeEach(() => {
    for (const key of Object.keys(walletStore)) {
      delete walletStore[Number(key)];
    }
  });

  it("detects a credit: second poll returns higher balance_kobo than first", async () => {
    const USER_ID = 100;
    setWalletBalance(USER_ID, 0);
    const caller = getWalletCaller(USER_ID);

    // First poll: balance is 0 (payment initiated, not yet reconciled)
    const before = await caller.wallet.getBalance();
    expect(before.balance_kobo).toBe(0);

    // Simulate reconciliation crediting the wallet (₦5,000 = 500,000 kobo)
    setWalletBalance(USER_ID, 500_000);

    // Second poll: balance should now reflect the credit
    const after = await caller.wallet.getBalance();
    expect(after.balance_kobo).toBe(500_000);
    expect(after.balance_kobo).toBeGreaterThan(before.balance_kobo);
    expect(after.balance_kobo - before.balance_kobo).toBe(500_000);
  });

  it("no credit: successive polls return the same balance", async () => {
    const USER_ID = 101;
    setWalletBalance(USER_ID, 200_000);
    const caller = getWalletCaller(USER_ID);

    const poll1 = await caller.wallet.getBalance();
    const poll2 = await caller.wallet.getBalance();

    expect(poll1.balance_kobo).toBe(poll2.balance_kobo);
    expect(poll2.balance_kobo - poll1.balance_kobo).toBe(0);
  });

  it("detects a partial credit: balance increases by less than the full top-up amount", async () => {
    const USER_ID = 102;
    setWalletBalance(USER_ID, 100_000); // ₦1,000 existing balance
    const caller = getWalletCaller(USER_ID);

    const before = await caller.wallet.getBalance();
    expect(before.balance_kobo).toBe(100_000);

    // Partial credit (₦2,000 credited out of ₦5,000 top-up)
    setWalletBalance(USER_ID, 300_000);

    const after = await caller.wallet.getBalance();
    expect(after.balance_kobo).toBe(300_000);
    expect(after.balance_kobo).toBeGreaterThan(before.balance_kobo);
  });

  it("multiple credits across polls: each poll reflects the latest balance", async () => {
    const USER_ID = 103;
    setWalletBalance(USER_ID, 0);
    const caller = getWalletCaller(USER_ID);

    const poll1 = await caller.wallet.getBalance();
    expect(poll1.balance_kobo).toBe(0);

    setWalletBalance(USER_ID, 500_000);
    const poll2 = await caller.wallet.getBalance();
    expect(poll2.balance_kobo).toBe(500_000);

    setWalletBalance(USER_ID, 1_000_000);
    const poll3 = await caller.wallet.getBalance();
    expect(poll3.balance_kobo).toBe(1_000_000);

    expect(poll2.balance_kobo).toBeGreaterThan(poll1.balance_kobo);
    expect(poll3.balance_kobo).toBeGreaterThan(poll2.balance_kobo);
  });

  it("tier upgrades on credit: basic → standard when balance crosses ₦10,000", async () => {
    const USER_ID = 104;
    setWalletBalance(USER_ID, 900_000); // ₦9,000 — just below standard threshold
    const caller = getWalletCaller(USER_ID);

    const before = await caller.wallet.getBalance();
    expect(before.tier).toBe("basic");

    // Credit pushes balance above ₦10,000
    setWalletBalance(USER_ID, 1_100_000); // ₦11,000

    const after = await caller.wallet.getBalance();
    expect(after.tier).toBe("standard");
    expect(after.balance_kobo).toBeGreaterThan(before.balance_kobo);
  });
});
