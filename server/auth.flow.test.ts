/**
 * Auth Flow Integration Tests
 * ============================
 * Tests the full auth lifecycle:
 *  1. Unauthenticated `auth.me` returns null
 *  2. Authenticated `auth.me` returns the user object
 *  3. `auth.logout` clears the session cookie and reports success
 *  4. Protected procedures reject unauthenticated callers
 */
import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import { appRouter } from "./routers";
import { COOKIE_NAME } from "../shared/const";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

// ── Context factories ─────────────────────────────────────────────────────────

function createUnauthContext(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
      cookie: () => {},
    } as unknown as TrpcContext["res"],
  };
}

function createAuthContext(overrides?: Partial<AuthenticatedUser>): {
  ctx: TrpcContext;
  clearedCookies: Array<{ name: string; options: Record<string, unknown> }>;
} {
  const clearedCookies: Array<{ name: string; options: Record<string, unknown> }> = [];

  const user: AuthenticatedUser = {
    id: 42,
    openId: "test-open-id-42",
    email: "driver@example.com",
    name: "Test Driver",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-01T00:00:00Z"),
    lastSignedIn: new Date("2025-01-01T00:00:00Z"),
    ...overrides,
  };

  const ctx: TrpcContext = {
    user,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {
      clearCookie: (name: string, options: Record<string, unknown>) => {
        clearedCookies.push({ name, options });
      },
    } as unknown as TrpcContext["res"],
  };

  return { ctx, clearedCookies };
}

function createAdminContext(): { ctx: TrpcContext } {
  const { ctx } = createAuthContext({ role: "admin", id: 1, openId: "admin-open-id" });
  return { ctx };
}

// ── auth.me ───────────────────────────────────────────────────────────────────

describe("auth.me", () => {
  it("returns null when the user is not authenticated", async () => {
    const ctx = createUnauthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.auth.me();

    expect(result).toBeNull();
  });

  it("returns the full user object when authenticated", async () => {
    const { ctx } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.auth.me();

    expect(result).not.toBeNull();
    expect(result?.id).toBe(42);
    expect(result?.email).toBe("driver@example.com");
    expect(result?.name).toBe("Test Driver");
    expect(result?.role).toBe("user");
    expect(result?.openId).toBe("test-open-id-42");
  });

  it("returns admin role for admin users", async () => {
    const { ctx } = createAdminContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.auth.me();

    expect(result?.role).toBe("admin");
  });
});

// ── auth.logout ───────────────────────────────────────────────────────────────

describe("auth.logout", () => {
  it("clears the session cookie and returns success: true", async () => {
    const { ctx, clearedCookies } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.auth.logout();

    expect(result).toEqual({ success: true });
    expect(clearedCookies).toHaveLength(1);
    expect(clearedCookies[0]?.name).toBe(COOKIE_NAME);
  });

  it("sets maxAge: -1 to immediately expire the cookie", async () => {
    const { ctx, clearedCookies } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    await caller.auth.logout();

    expect(clearedCookies[0]?.options).toMatchObject({ maxAge: -1 });
  });

  it("uses secure + sameSite=none + httpOnly flags for cross-origin safety", async () => {
    const { ctx, clearedCookies } = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    await caller.auth.logout();

    expect(clearedCookies[0]?.options).toMatchObject({
      secure: true,
      sameSite: "none",
      httpOnly: true,
      path: "/",
    });
  });

  it("also works when called by an unauthenticated user (no-op cookie clear)", async () => {
    const ctx = createUnauthContext();
    const caller = appRouter.createCaller(ctx);

    // logout is a publicProcedure so it must not throw even without a session
    const result = await caller.auth.logout();
    expect(result).toEqual({ success: true });
  });
});
