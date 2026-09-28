/**
 * Redis integration — cache, rate-limit persistence, WS pub/sub, USSD sessions.
 *
 * ENABLE WHEN: any of (a) >1 app replica needs shared rate limits or WS
 * fan-out, (b) USSD goes live (sessions must survive deploys), (c) DB-backed
 * OTP/cache reads become hot. Until then the app runs fine without Redis.
 *
 * GRACEFUL DEGRADATION: REDIS_URL unset or ioredis not installed ⇒ every
 * export becomes a no-op / null; a single warning is logged, never a crash.
 *
 * Compose profile: `core`. Env: REDIS_URL (redis://[:pass@]host:6379[/db]).
 */

import {
  DISABLED_HEALTH,
  importOptional,
  logOnce,
  parseEnvOrNull,
  present,
  withRetry,
  z,
  type IntegrationHealth,
} from "./_common";

const envSchema = z.object({
  REDIS_URL: z.string().min(1),
  REDIS_KEY_PREFIX: z.string().min(1).optional(),
});

type Env = z.output<typeof envSchema>;

/** Structural subset of ioredis.Redis — keeps this module compilable without
 * the ioredis package installed while staying compatible with the real client. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  ttl(key: string): Promise<number>;
  ping(): Promise<string>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(...channels: string[]): Promise<number>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  duplicate(): RedisLike;
  quit(): Promise<unknown>;
  disconnect(): void;
  status: string;
}

interface IORedisModule {
  default: new (url: string, options?: Record<string, unknown>) => RedisLike;
}

const DEFAULT_TTL_SECONDS = 3600;
const USSD_SESSION_TTL_SECONDS = 5 * 60; // NCC USSD session ceiling is ~120–180s; 5 min gives margin

let _env: Env | null | undefined;
let _client: RedisLike | null = null;
let _connecting: Promise<RedisLike | null> | null = null;

function env(): Env | null {
  if (_env === undefined) {
    _env = parseEnvOrNull(envSchema, process.env, "Redis");
  }
  return _env;
}

function prefix(): string {
  return env()?.REDIS_KEY_PREFIX ?? "np:";
}

/** True when Redis is configured (does NOT mean connected). */
export function redisEnabled(): boolean {
  return env() !== null;
}

/**
 * Return the shared ioredis-compatible client, or null when disabled.
 * Lazily connects with retry/backoff; safe to call per-request.
 */
export async function getRedis(): Promise<RedisLike | null> {
  const e = env();
  if (!e) return null;
  if (_client && _client.status === "ready") return _client;
  if (_connecting) return _connecting;

  _connecting = (async () => {
    const mod = await importOptional<IORedisModule>("ioredis", "Redis");
    if (!mod || typeof mod.default !== "function") return null;
    try {
      const client = await withRetry(
        async () => {
          const c = new mod.default(e.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: 2,
            retryStrategy: (times: number) => Math.min(2000, 100 * 2 ** times),
            enableOfflineQueue: true,
          });
          await (c as unknown as { connect(): Promise<void> }).connect();
          return c;
        },
        { label: "redis-connect", attempts: 3 },
      );
      client.on("error", (err: unknown) => {
        logOnce("redis:err", "error", `[Redis] client error: ${err instanceof Error ? err.message : String(err)}`);
      });
      _client = client;
      return client;
    } catch (err) {
      logOnce("redis:fail", "warn", `[Redis] unreachable — continuing without Redis (${err instanceof Error ? err.message : String(err)})`);
      return null;
    } finally {
      _connecting = null;
    }
  })();
  return _connecting;
}

/** PING health probe. ok=true when disabled (nothing to fail). */
export async function redisHealth(): Promise<IntegrationHealth> {
  if (!redisEnabled()) return DISABLED_HEALTH;
  const started = Date.now();
  const client = await getRedis();
  if (!client) return { enabled: true, ok: false, error: "client unavailable" };
  try {
    const pong = await client.ping();
    return { enabled: true, ok: pong === "PONG", latencyMs: Date.now() - started };
  } catch (err) {
    return { enabled: true, ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── JSON cache helpers ────────────────────────────────────────────────────────

/** Read and JSON-parse a cached value. Returns null on miss/error/disabled. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  const client = await getRedis();
  if (!client) return null;
  try {
    const raw = await client.get(prefix() + key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null; // cache must never break the request path
  }
}

/** Write a JSON-serializable value with TTL (default 1h). No-op when disabled. */
export async function cacheSet(key: string, value: unknown, ttlSeconds: number = DEFAULT_TTL_SECONDS): Promise<void> {
  const client = await getRedis();
  if (!client) return;
  try {
    await client.set(prefix() + key, JSON.stringify(value), "EX", Math.max(1, Math.floor(ttlSeconds)));
  } catch {
    /* cache write failures are non-fatal */
  }
}

/** Delete a cached key. No-op when disabled. */
export async function cacheDel(key: string): Promise<void> {
  const client = await getRedis();
  if (!client) return;
  try {
    await client.del(prefix() + key);
  } catch {
    /* non-fatal */
  }
}

// ── express-rate-limit adapter ────────────────────────────────────────────────

/**
 * Structural contract of express-rate-limit's `Store` (v7/v8). Defined here so
 * the adapter type-checks whether or not express-rate-limit is installed.
 */
export interface RateLimitStoreLike {
  increment(key: string): Promise<{ totalHits: number; resetTime: Date | undefined }>;
  decrement(key: string): Promise<void>;
  resetKey(key: string): Promise<void>;
  shutdown?(): void;
}

/**
 * Build a Redis-backed store for express-rate-limit, or null when Redis is
 * disabled (caller then falls back to the default in-memory store).
 *
 * Usage: `const store = await makeRateLimitStore();`
 *        `rateLimit({ windowMs, limit, ...(store ? { store } : {}) })`
 */
export async function makeRateLimitStore(opts: { windowMs?: number } = {}): Promise<RateLimitStoreLike | null> {
  const client = await getRedis();
  if (!client) return null;
  const windowMs = opts.windowMs ?? 60_000;
  const keyFor = (k: string) => `${prefix()}rl:${k}`;
  return {
    async increment(key: string) {
      const k = keyFor(key);
      const totalHits = await client.incr(k);
      if (totalHits === 1) await client.pexpire(k, windowMs);
      const ttl = await client.ttl(k);
      return { totalHits, resetTime: ttl > 0 ? new Date(Date.now() + ttl * 1000) : undefined };
    },
    async decrement(key: string) {
      const k = keyFor(key);
      const after = await client.decr(k); // preserves TTL; floor at 0
      if (after < 0) await client.set(k, "0", "KEEPTTL");
    },
    async resetKey(key: string) {
      await client.del(keyFor(key));
    },
  };
}

// ── WebSocket scale-out pub/sub ───────────────────────────────────────────────

export interface PubSubPair {
  publish(channel: string, payload: unknown): Promise<void>;
  subscribe(channel: string, handler: (payload: unknown) => void): Promise<void>;
  close(): Promise<void>;
}

/**
 * Create a dedicated pub/sub pair (separate connections, per Redis protocol)
 * for fan-out of WebSocket events (KYC status, wallet credit, device
 * heartbeat) across app replicas. Returns null when Redis is disabled —
 * single-replica deployments broadcast in-process and need nothing here.
 */
export async function createPubSub(): Promise<PubSubPair | null> {
  const base = await getRedis();
  if (!base) return null;
  const sub = base.duplicate();
  const pub = base.duplicate();
  return {
    async publish(channel, payload) {
      await pub.publish(prefix() + "ps:" + channel, JSON.stringify(payload));
    },
    async subscribe(channel, handler) {
      sub.on("message", (_ch: unknown, message: unknown) => {
        if (typeof message !== "string") return;
        try {
          handler(JSON.parse(message));
        } catch {
          /* ignore malformed frames */
        }
      });
      await sub.subscribe(prefix() + "ps:" + channel);
    },
    async close() {
      sub.disconnect();
      pub.disconnect();
    },
  };
}

// ── USSD session store ────────────────────────────────────────────────────────

export interface UssdSessionStore {
  get<T = unknown>(sessionId: string): Promise<T | null>;
  set(sessionId: string, state: unknown): Promise<void>;
  del(sessionId: string): Promise<void>;
}

const ussdKey = (sessionId: string) => `${prefix()}ussd:session:${sessionId}`;

/**
 * USSD session store with a hard 5-minute TTL. Nigerian telco USSD sessions
 * time out around 120–180s; 5 minutes keeps state across the final confirm
 * step without leaking memory.
 *
 * When Redis is disabled the store falls back to a process-local Map —
 * acceptable for a single replica in dev, NOT for multi-replica production
 * (telco gateways round-robin callbacks). A warning is logged once in that
 * case.
 */
const memoryFallback = new Map<string, { value: string; expiresAt: number }>();

export const ussdSessionStore: UssdSessionStore = {
  async get<T>(sessionId: string): Promise<T | null> {
    const client = await getRedis();
    if (client) {
      const raw = await client.get(ussdKey(sessionId));
      return raw === null ? null : (JSON.parse(raw) as T);
    }
    logOnce("ussd:mem", "warn", "[Redis] USSD sessions using in-memory fallback — single-replica only");
    const hit = memoryFallback.get(sessionId);
    if (!hit || hit.expiresAt < Date.now()) {
      memoryFallback.delete(sessionId);
      return null;
    }
    return JSON.parse(hit.value) as T;
  },
  async set(sessionId: string, state: unknown): Promise<void> {
    const client = await getRedis();
    if (client) {
      await client.set(ussdKey(sessionId), JSON.stringify(state), "EX", USSD_SESSION_TTL_SECONDS);
      return;
    }
    memoryFallback.set(sessionId, {
      value: JSON.stringify(state),
      expiresAt: Date.now() + USSD_SESSION_TTL_SECONDS * 1000,
    });
  },
  async del(sessionId: string): Promise<void> {
    const client = await getRedis();
    if (client) {
      await client.del(ussdKey(sessionId));
      return;
    }
    memoryFallback.delete(sessionId);
  },
};

/** For graceful shutdown in server/_core/index.ts. */
export async function closeRedis(): Promise<void> {
  if (_client) {
    try {
      await _client.quit();
    } catch {
      _client.disconnect();
    }
    _client = null;
  }
}

// Re-export for callers that want to test env presence without connecting.
export { present as _redisEnvPresent };
