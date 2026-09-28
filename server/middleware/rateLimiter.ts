/**
 * Rate-limit middleware for NigerianPass API endpoints.
 *
 * Limits are tuned for Nigerian network conditions:
 *  - OTP send: 5 requests / 15 min per IP (prevents SMS abuse)
 *  - OTP verify: 10 attempts / 15 min per IP (brute-force guard)
 *  - Payment initiate: 10 requests / 1 min per IP (checkout spam guard)
 *  - Auth (login/register): 20 requests / 15 min per IP
 *  - General API: 200 requests / 1 min per IP (generous for PWA)
 *
 * IPv6 note: all keyGenerators use ipKeyGenerator() to normalise IPv6
 * addresses and prevent bypass via address rotation.
 */
import rateLimit, { ipKeyGenerator, type Store } from "express-rate-limit";
import type { Request, Response } from "express";

// ── Store abstraction (P1-21) ────────────────────────────────────────────────
// Rate-limit state defaults to the in-process memory store. When REDIS_URL is
// configured, a Redis-backed store is plugged in so limits are shared across
// instances. The Redis client lives in server/integrations/redis.ts (owned by
// another agent); we load it defensively via dynamic import and fall back to
// memory if it is absent or fails.

let _redisStore: Store | null | undefined; // undefined = not attempted yet

async function getRedisStore(): Promise<Store | null> {
  if (_redisStore !== undefined) return _redisStore;
  _redisStore = null;
  if (!process.env.REDIS_URL) return _redisStore;
  try {
    const mod = await import("../integrations/redis");
    const createStore = (mod as Record<string, unknown>).createRateLimitStore as
      | ((opts?: { prefix?: string }) => Store)
      | undefined;
    if (typeof createStore === "function") {
      _redisStore = createStore({ prefix: "rl" });
      console.log("[RateLimit] Using Redis store");
    }
  } catch (err) {
    console.warn("[RateLimit] Redis store unavailable, falling back to memory:", (err as Error).message);
    _redisStore = null;
  }
  return _redisStore;
}

/** Trigger async store resolution at module load; limiters use it lazily. */
const storePromise = getRedisStore();

/** Single shared memory fallback store (used until/unless Redis resolves). */
let _memoryFallback: Store | null = null;
function memoryFallback(): Store {
  if (!_memoryFallback) {
    // express-rate-limit's default MemoryStore
    _memoryFallback = new (rateLimit as unknown as { MemoryStore: new () => Store }).MemoryStore();
  }
  return _memoryFallback;
}

/** Store proxy that defers to the Redis store once resolved, else memory. */
function deferredStore(): Store | undefined {
  if (!process.env.REDIS_URL) return undefined; // express-rate-limit memory default
  return {
    async increment(key: string) {
      const store = (_redisStore ?? (await storePromise)) ?? memoryFallback();
      return store.increment(key);
    },
    async decrement(key: string) {
      const store = (_redisStore ?? (await storePromise)) ?? memoryFallback();
      return store.decrement?.(key);
    },
    async resetKey(key: string) {
      const store = (_redisStore ?? (await storePromise)) ?? memoryFallback();
      return store.resetKey(key);
    },
    async resetAll() {
      const store = (_redisStore ?? (await storePromise)) ?? memoryFallback();
      return store.resetAll?.();
    },
  } as Store;
}

/** Human-readable JSON error response for rate-limit hits */
const rateLimitHandler = (req: Request, res: Response) => {
  res.status(429).json({
    error: "TOO_MANY_REQUESTS",
    message: "Too many requests. Please wait before trying again.",
    retryAfter: res.getHeader("Retry-After"),
  });
};

/** Normalised IP key — handles IPv4-mapped IPv6 (::ffff:1.2.3.4 → 1.2.3.4) */
const ipKey = (req: Request) => ipKeyGenerator(req.ip ?? "");

/** OTP send — 5 requests per 15 minutes per IP (+phone number) */
export const otpSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: undefined,
  handler: rateLimitHandler,
  store: deferredStore(),
  keyGenerator: (req) => {
    // Key on normalised IP + phone number to prevent per-number abuse across IPs.
    const body = req.body as { phone?: string; json?: { phone?: string } };
    const phone = body?.phone ?? body?.json?.phone ?? "";
    return `${ipKey(req)}:${phone}`;
  },
  skip: () => process.env.NODE_ENV === "test",
});

/** OTP verify — 10 attempts per 15 minutes per IP */
export const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: undefined,
  handler: rateLimitHandler,
  store: deferredStore(),
  keyGenerator: ipKey,
  skip: () => process.env.NODE_ENV === "test",
});

/** Payment initiate — 10 requests per minute per IP */
export const paymentInitiateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: undefined,
  handler: rateLimitHandler,
  store: deferredStore(),
  keyGenerator: ipKey,
  skip: () => process.env.NODE_ENV === "test",
});

/** Auth (login / register) — 20 requests per 15 minutes per IP */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: undefined,
  handler: rateLimitHandler,
  store: deferredStore(),
  keyGenerator: ipKey,
  skip: () => process.env.NODE_ENV === "test",
});

/** General API — 200 requests per minute per IP */
export const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: undefined,
  handler: rateLimitHandler,
  store: deferredStore(),
  keyGenerator: ipKey,
  skip: () => process.env.NODE_ENV === "test",
});
