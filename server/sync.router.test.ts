/**
 * Sync Router Tests
 * =================
 * Tests the background sync tRPC procedures:
 *  - sync.ping           — public connectivity probe
 *  - sync.walletBalance  — returns wallet balance for authenticated user
 *  - sync.kycStatuses    — returns KYC application list for authenticated user
 *  - sync.processQueue   — replays queued mutations; rejects invalid URLs
 *  - sync.registerPeriodicSync — records periodic sync preference
 *
 * DB calls are mocked so tests run without a real database connection.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// ── Mock the DB helpers so tests don't need a real DB ─────────────────────────
vi.mock("./db", () => ({
  getOrCreateWalletAccount: vi.fn().mockResolvedValue({
    id: 1,
    userId: 42,
    tigerBeetleId: "TB0000000042ABC",
    balanceKobo: 1500000,       // ₦15,000
    dailyCapKobo: 500000,       // ₦5,000
    dailySpentKobo: 120000,     // ₦1,200
    lastBalanceSync: new Date("2025-03-01T10:00:00Z"),
  }),
  getWalletTransactions: vi.fn().mockResolvedValue([
    {
      id: 1,
      walletId: 1,
      type: "credit",
      amountKobo: 500000,
      balanceAfterKobo: 1500000,
      description: "Top-up via Paystack",
      createdAt: new Date("2025-03-01T09:00:00Z"),
    },
  ]),
  getKycApplicationsByUserId: vi.fn().mockResolvedValue([
    {
      id: 1,
      referenceId: "DRV-ABCDE",
      userId: 42,
      type: "driver",
      status: "under_review",
      createdAt: new Date("2025-02-28T08:00:00Z"),
      updatedAt: new Date("2025-03-01T08:00:00Z"),
      kycScore: 87,
      fromOfflineQueue: false,
    },
  ]),
  createKycApplication: vi.fn().mockResolvedValue({
    referenceId: "DRV-NEWXX",
    status: "submitted",
    createdAt: new Date(),
  }),
  generateReferenceId: vi.fn().mockReturnValue("DRV-NEWXX"),
  upsertSyncQueueItem: vi.fn().mockResolvedValue({ clientId: "test-client-id" }),
  markSyncQueueItemDone: vi.fn().mockResolvedValue(undefined),
  markSyncQueueItemFailed: vi.fn().mockResolvedValue(undefined),
}));

// ── Context factories ─────────────────────────────────────────────────────────

function createUnauthContext(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

function createAuthContext(id = 42): TrpcContext {
  return {
    user: {
      id,
      openId: `open-id-${id}`,
      email: `user${id}@example.com`,
      name: `Test User ${id}`,
      loginMethod: "manus",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

// ── sync.ping ─────────────────────────────────────────────────────────────────

describe("sync.ping", () => {
  it("returns ok: true and a serverTime timestamp", async () => {
    const before = Date.now();
    const caller = appRouter.createCaller(createUnauthContext());

    const result = await caller.sync.ping();

    expect(result.ok).toBe(true);
    expect(result.serverTime).toBeGreaterThanOrEqual(before);
    expect(result.version).toBe("1.0.0");
  });

  it("is accessible without authentication", async () => {
    const caller = appRouter.createCaller(createUnauthContext());
    // Should not throw
    await expect(caller.sync.ping()).resolves.toBeDefined();
  });
});

// ── sync.walletBalance ────────────────────────────────────────────────────────

describe("sync.walletBalance", () => {
  it("returns balance in NGN (kobo / 100)", async () => {
    const caller = appRouter.createCaller(createAuthContext());

    const result = await caller.sync.walletBalance();

    expect(result.balance).toBe(15000);          // 1_500_000 kobo → ₦15,000
    expect(result.currency).toBe("NGN");
    expect(result.dailyFareCap).toBe(5000);
    expect(result.dailySpent).toBe(1200);
    expect(result.userId).toBe(42);
  });

  it("includes recent transactions", async () => {
    const caller = appRouter.createCaller(createAuthContext());

    const result = await caller.sync.walletBalance();

    expect(result.recentTransactions).toHaveLength(1);
    expect(result.recentTransactions[0]?.type).toBe("credit");
    expect(result.recentTransactions[0]?.amount).toBe(5000);
  });

  it("throws UNAUTHORIZED when called without a session", async () => {
    const caller = appRouter.createCaller(createUnauthContext());

    await expect(caller.sync.walletBalance()).rejects.toThrow(TRPCError);
  });
});

// ── sync.kycStatuses ──────────────────────────────────────────────────────────

describe("sync.kycStatuses", () => {
  it("returns the user's KYC applications from the DB", async () => {
    const caller = appRouter.createCaller(createAuthContext());

    const result = await caller.sync.kycStatuses();

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("DRV-ABCDE");
    expect(result[0]?.type).toBe("driver");
    expect(result[0]?.status).toBe("under_review");
    expect(result[0]?.kycScore).toBe(87);
  });

  it("throws UNAUTHORIZED when called without a session", async () => {
    const caller = appRouter.createCaller(createUnauthContext());

    await expect(caller.sync.kycStatuses()).rejects.toThrow(TRPCError);
  });
});

// ── sync.processQueue ─────────────────────────────────────────────────────────

describe("sync.processQueue", () => {
  const validKycItem = {
    id: "client-uuid-001",
    url: "/api/trpc/sync.submitKycDraft",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "driver", formData: { firstName: "Amaka" }, clientVersion: 1 }),
    label: "kyc-driver-onboarding",
    attempts: 0,
    createdAt: Date.now() - 60000,
  };

  it("processes a valid KYC queued item and returns success", async () => {
    const caller = appRouter.createCaller(createAuthContext());

    const result = await caller.sync.processQueue({ items: [validKycItem] });

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.results[0]?.success).toBe(true);
    expect(result.results[0]?.id).toBe("client-uuid-001");
  });

  it("rejects items with non-/api/ URLs (SSRF protection)", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const maliciousItem = {
      ...validKycItem,
      id: "client-uuid-002",
      url: "https://evil.example.com/steal",
    };

    const result = await caller.sync.processQueue({ items: [maliciousItem] });

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.results[0]?.error).toContain("Invalid URL");
  });

  it("processes multiple items and reports per-item results", async () => {
    const caller = appRouter.createCaller(createAuthContext());
    const items = [
      validKycItem,
      { ...validKycItem, id: "client-uuid-003", label: "wallet-topup" },
    ];

    const result = await caller.sync.processQueue({ items });

    expect(result.processed + result.failed).toBe(2);
    expect(result.results).toHaveLength(2);
  });

  it("returns empty results for an empty queue", async () => {
    const caller = appRouter.createCaller(createAuthContext());

    const result = await caller.sync.processQueue({ items: [] });

    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it("throws UNAUTHORIZED when called without a session", async () => {
    const caller = appRouter.createCaller(createUnauthContext());

    await expect(
      caller.sync.processQueue({ items: [validKycItem] })
    ).rejects.toThrow(TRPCError);
  });
});

// ── sync.registerPeriodicSync ─────────────────────────────────────────────────

describe("sync.registerPeriodicSync", () => {
  it("records the sync registration and returns success", async () => {
    const caller = appRouter.createCaller(createAuthContext());

    const result = await caller.sync.registerPeriodicSync({
      tags: ["wallet-balance", "kyc-status"],
      minIntervalMs: 15 * 60 * 1000,
    });

    expect(result.success).toBe(true);
    expect(result.tags).toEqual(["wallet-balance", "kyc-status"]);
    expect(result.registeredAt).toBeGreaterThan(0);
  });

  it("throws UNAUTHORIZED when called without a session", async () => {
    const caller = appRouter.createCaller(createUnauthContext());

    await expect(
      caller.sync.registerPeriodicSync({ tags: ["wallet-balance"] })
    ).rejects.toThrow(TRPCError);
  });
});
