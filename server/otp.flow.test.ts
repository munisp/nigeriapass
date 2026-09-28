/**
 * OTP Flow Integration Tests
 * ===========================
 * Tests the full SMS OTP lifecycle:
 *  1. otp.send  — generates a code, returns masked phone + demo code in demo mode
 *  2. otp.verify — accepts the correct code, upserts the user, sets a JWT cookie
 *  3. otp.verify — rejects wrong codes and tracks attempt count
 *  4. otp.verify — rejects expired codes
 *  5. otp.verify — locks out after 5 failed attempts
 *
 * The test suite runs entirely in-memory:
 *  - DB calls are mocked via vi.mock so no live PostgreSQL is required
 *  - Cookie writes are captured via a mock res.cookie
 *  - JWT tokens are decoded to verify claims
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import type { TrpcContext } from "./_core/context";

// JWT_SECRET must be set BEFORE the env module (./_core/env) is evaluated by
// the static router imports below — the hardened env no longer provides a
// fallback cookie secret, and jose refuses to sign with a zero-length key.
// vi.hoisted runs before any import in this file.
vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-for-otp-flow";
  process.env.NODE_ENV = "test"; // demo OTP mode is only allowed outside production
});

// ── Mock the DB layer ─────────────────────────────────────────────────────────
// We mock the entire db module so the OTP service never needs a live PG instance.
// vi.hoisted ensures mockDb is available before vi.mock hoisting runs.

const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  return { mockDb };
});

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    ...actual,
    getDb: vi.fn().mockResolvedValue(mockDb),
    upsertUser: vi.fn().mockResolvedValue(undefined),
    getUserByOpenId: vi.fn().mockResolvedValue({
      id: 99,
      openId: "phone:+2348012345678",
      name: "+2348012345678",
      email: null,
      role: "user",
      loginMethod: "sms_otp",
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2025-01-01T00:00:00Z"),
      lastSignedIn: new Date("2025-01-01T00:00:00Z"),
    }),
  };
});

// ── Mock Africa's Talking (force demo mode) ───────────────────────────────────
// The OTP service reads AT_API_KEY at module load time; we ensure demo mode by
// not setting the env var (it defaults to "" → DEMO_MODE = true).

// ── Import router AFTER mocks are set up ─────────────────────────────────────
import { appRouter } from "./routers";
import { COOKIE_NAME } from "../shared/const";
import { jwtVerify } from "jose";
import { ENV } from "./_core/env";
import bcrypt from "bcryptjs";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_PHONE = "+2348012345678";
const DEMO_CODE = "123456";

type SetCookieCall = { name: string; value: string; options: Record<string, unknown> };

function createOtpContext(): { ctx: TrpcContext; cookies: SetCookieCall[] } {
  const cookies: SetCookieCall[] = [];
  const ctx: TrpcContext = {
    user: null,
    req: {
      protocol: "https",
      headers: { "x-forwarded-for": "192.168.1.1" },
      socket: { remoteAddress: "192.168.1.1" },
    } as unknown as TrpcContext["req"],
    res: {
      cookie: (name: string, value: string, options: Record<string, unknown>) => {
        cookies.push({ name, value, options });
      },
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
  return { ctx, cookies };
}

// Build a chainable Drizzle query mock for SELECT
function buildSelectMock(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  return chain;
}

// Build a chainable Drizzle query mock for INSERT / UPDATE / DELETE
function buildMutationMock() {
  return {
    values: vi.fn().mockResolvedValue({ rowCount: 1 }),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue({ rowCount: 1 }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("otp.send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReturnValue(buildSelectMock([]));
    mockDb.insert.mockReturnValue(buildMutationMock());
    mockDb.update.mockReturnValue(buildMutationMock());
  });

  it("returns success with a masked phone number", async () => {
    const { ctx } = createOtpContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.otp.send({ phone: TEST_PHONE });

    expect(result.success).toBe(true);
    expect(result.maskedPhone).toMatch(/^\+234\d{3}\*{4}\d+$/);
    expect(result.expiresInSeconds).toBe(120);
  });

  it("returns the demo code in demo mode (AT_API_KEY not set)", async () => {
    const { ctx } = createOtpContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.otp.send({ phone: TEST_PHONE });

    // In demo mode the actual code is returned for testing convenience
    expect(result.demoCode).toBeDefined();
    expect(result.demoCode).toMatch(/^\d{6}$/);
  });

  it("rejects invalid phone number format", async () => {
    const { ctx } = createOtpContext();
    const caller = appRouter.createCaller(ctx);

    await expect(caller.otp.send({ phone: "08012345678" })).rejects.toThrow();
  });

  it("rejects phone numbers without country code", async () => {
    const { ctx } = createOtpContext();
    const caller = appRouter.createCaller(ctx);

    await expect(caller.otp.send({ phone: "8012345678" })).rejects.toThrow();
  });
});

describe("otp.verify — demo mode (code = 123456)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReturnValue(buildSelectMock([]));
    mockDb.insert.mockReturnValue(buildMutationMock());
    mockDb.update.mockReturnValue(buildMutationMock());
  });

  it("accepts the demo code 123456 and sets a JWT session cookie", async () => {
    const { ctx, cookies } = createOtpContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.otp.verify({ phone: TEST_PHONE, code: DEMO_CODE });

    expect(result.success).toBe(true);
    expect(result.user).toBeDefined();
    expect(result.user.openId).toBe(`phone:${TEST_PHONE}`);
    expect(result.user.role).toBe("user");
    expect(result.user.loginMethod).toBe("sms_otp");

    // Cookie must have been set
    expect(cookies).toHaveLength(1);
    expect(cookies[0]?.name).toBe(COOKIE_NAME);
    expect(cookies[0]?.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it("JWT token contains correct claims", async () => {
    const { ctx, cookies } = createOtpContext();
    const caller = appRouter.createCaller(ctx);

    await caller.otp.verify({ phone: TEST_PHONE, code: DEMO_CODE });

    const token = cookies[0]?.value;
    expect(token).toBeTruthy();

    const secret = new TextEncoder().encode(ENV.cookieSecret);
    const { payload } = await jwtVerify(token!, secret);

    expect(payload.openId).toBe(`phone:${TEST_PHONE}`);
    expect(payload.loginMethod).toBe("sms_otp");
    expect(payload.role).toBe("user");
    expect(typeof payload.sub).toBe("string");
  });

  it("rejects an incorrect 6-digit code", async () => {
    const { ctx } = createOtpContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.otp.verify({ phone: TEST_PHONE, code: "000000" })
    ).rejects.toThrow(TRPCError);
  });

  it("rejects codes that are not 6 digits", async () => {
    const { ctx } = createOtpContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.otp.verify({ phone: TEST_PHONE, code: "12345" })
    ).rejects.toThrow();
  });

  it("rejects non-numeric codes", async () => {
    const { ctx } = createOtpContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.otp.verify({ phone: TEST_PHONE, code: "abcdef" })
    ).rejects.toThrow();
  });
});

describe("otp.verify — DB-backed mode (real bcrypt hash)", () => {
  // Use a code that is NOT the demo code (123456) so the service hits the DB path
  const REAL_CODE = "789012";
  const WRONG_CODE = "000000";
  let hashedCode: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    hashedCode = await bcrypt.hash(REAL_CODE, 10);
    mockDb.insert.mockReturnValue(buildMutationMock());
    mockDb.update.mockReturnValue(buildMutationMock());
  });

  function buildOtpRecord(overrides: Partial<{
    used: boolean;
    attempts: number;
    expiresAt: Date;
    codeHash: string;
  }> = {}) {
    return {
      id: 1,
      phone: TEST_PHONE,
      codeHash: hashedCode,
      used: false,
      attempts: 0,
      requestIp: "192.168.1.1",
      messageId: "demo-message-id",
      expiresAt: new Date(Date.now() + 2 * 60 * 1000), // 2 min from now
      createdAt: new Date(),
      ...overrides,
    };
  }

  it("accepts a valid bcrypt-hashed code from DB", async () => {
    // First select: active code found; second select (expired check): not needed
    mockDb.select
      .mockReturnValueOnce(buildSelectMock([buildOtpRecord()]))
      .mockReturnValue(buildSelectMock([]));

    const { ctx, cookies } = createOtpContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.otp.verify({ phone: TEST_PHONE, code: REAL_CODE });

    expect(result.success).toBe(true);
    expect(cookies).toHaveLength(1);
  });

  it("returns 'invalid' error and decrements attempts for wrong code", async () => {
    mockDb.select
      .mockReturnValueOnce(buildSelectMock([buildOtpRecord({ attempts: 1 })]))
      .mockReturnValue(buildSelectMock([]));

    const { ctx } = createOtpContext();
    const caller = appRouter.createCaller(ctx);

    const err = await caller.otp.verify({ phone: TEST_PHONE, code: "000000" }).catch(e => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
    expect((err as TRPCError).message).toContain("attempt");
  });

  it("returns 'expired' error when code has passed its expiry", async () => {
    // No active (non-expired) codes; one expired code exists
    // Use WRONG_CODE (not demo 123456) so the service doesn't short-circuit
    const expiredRecord = buildOtpRecord({
      expiresAt: new Date(Date.now() - 1000), // already expired
    });
    mockDb.select
      .mockReturnValueOnce(buildSelectMock([]))      // active query → empty
      .mockReturnValueOnce(buildSelectMock([expiredRecord])); // expired query → found

    const { ctx } = createOtpContext();
    const caller = appRouter.createCaller(ctx);

    const err = await caller.otp.verify({ phone: TEST_PHONE, code: WRONG_CODE }).catch(e => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).message).toContain("expired");
  });

  it("returns 'not_found' when no code exists at all", async () => {
    mockDb.select
      .mockReturnValueOnce(buildSelectMock([]))  // active query → empty
      .mockReturnValueOnce(buildSelectMock([])); // expired query → empty

    const { ctx } = createOtpContext();
    const caller = appRouter.createCaller(ctx);

    // Use WRONG_CODE so demo-mode short-circuit doesn't fire
    const err = await caller.otp.verify({ phone: TEST_PHONE, code: WRONG_CODE }).catch(e => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).message).toContain("No active code");
  });

  it("locks out after 5 failed attempts (max_attempts)", async () => {
    // Record already at attempt limit — use REAL_CODE so DB path is taken
    mockDb.select
      .mockReturnValueOnce(buildSelectMock([buildOtpRecord({ attempts: 5 })]))
      .mockReturnValue(buildSelectMock([]));

    const { ctx } = createOtpContext();
    const caller = appRouter.createCaller(ctx);

    const err = await caller.otp.verify({ phone: TEST_PHONE, code: REAL_CODE }).catch(e => e);
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).message).toContain("Too many");
  });
});

describe("otp full round-trip (send → verify → JWT)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockReturnValue(buildSelectMock([]));
    mockDb.insert.mockReturnValue(buildMutationMock());
    mockDb.update.mockReturnValue(buildMutationMock());
  });

  it("completes the full send → verify → JWT flow in demo mode", async () => {
    // Step 1: send — demo mode returns a random code in demoCode field
    const { ctx: sendCtx } = createOtpContext();
    const sendCaller = appRouter.createCaller(sendCtx);
    const sendResult = await sendCaller.otp.send({ phone: TEST_PHONE });

    expect(sendResult.success).toBe(true);
    expect(sendResult.demoCode).toBeDefined();

    // Step 2: verify — use the fixed demo code 123456 which the service always accepts
    // in demo mode regardless of what was "sent"
    const { ctx: verifyCxt, cookies } = createOtpContext();
    const verifyCaller = appRouter.createCaller(verifyCxt);
    const verifyResult = await verifyCaller.otp.verify({ phone: TEST_PHONE, code: DEMO_CODE });

    expect(verifyResult.success).toBe(true);
    expect(verifyResult.user.loginMethod).toBe("sms_otp");

    // Step 3: JWT — decode and assert claims
    const token = cookies[0]?.value;
    expect(token).toBeTruthy();
    const secret = new TextEncoder().encode(ENV.cookieSecret);
    const { payload } = await jwtVerify(token!, secret);
    expect(payload.loginMethod).toBe("sms_otp");
    expect(payload.openId).toBe(`phone:${TEST_PHONE}`);
  });

  it("returns user id in JWT sub claim", async () => {
    const { ctx, cookies } = createOtpContext();
    const caller = appRouter.createCaller(ctx);
    await caller.otp.verify({ phone: TEST_PHONE, code: DEMO_CODE });

    const token = cookies[0]?.value;
    const secret = new TextEncoder().encode(ENV.cookieSecret);
    const { payload } = await jwtVerify(token!, secret);
    // sub should be the user id as a string
    expect(typeof payload.sub).toBe("string");
    expect(Number(payload.sub)).toBeGreaterThan(0);
  });

  it("JWT expires in 7 days", async () => {
    const { ctx, cookies } = createOtpContext();
    const caller = appRouter.createCaller(ctx);
    await caller.otp.verify({ phone: TEST_PHONE, code: DEMO_CODE });

    const token = cookies[0]?.value;
    const secret = new TextEncoder().encode(ENV.cookieSecret);
    const { payload } = await jwtVerify(token!, secret);
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const expiresAt = (payload.exp ?? 0) * 1000;
    const issuedAt = (payload.iat ?? 0) * 1000;
    expect(expiresAt - issuedAt).toBeGreaterThanOrEqual(sevenDaysMs - 5000);
  });
});
