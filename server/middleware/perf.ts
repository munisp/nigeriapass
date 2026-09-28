/**
 * Performance middleware for the NigerianPass Express server.
 *
 * Provides:
 *  1. `compressionMiddleware()`  — gzip/deflate/brotli via the optional
 *     `compression` package, dynamically imported with a no-op fallback so
 *     the server still boots if the dependency is absent.
 *  2. `cacheControl()`           — centralised Cache-Control/ETag policy:
 *     immutable for content-hashed assets, no-store for API responses.
 *  3. `responseTime()`           — `X-Response-Time` header, in-memory p95
 *     tracking per route class, and timing-budget warnings.
 *
 * ── How to mount in server/_core/index.ts (do NOT edit here) ────────────────
 *
 *   import {
 *     compressionMiddleware,
 *     cacheControl,
 *     responseTime,
 *     logLatencyReport,
 *   } from "../middleware/perf";
 *
 *   async function startServer() {
 *     const app = express();
 *     ...
 *     // 1. FIRST — before body parsers, so every response is compressed/timed.
 *     app.use(await compressionMiddleware());
 *     app.use(responseTime());
 *     app.use(cacheControl());
 *     ...
 *     // existing rate limiters, tRPC, routers, static/vite ...
 *
 *     // Optional: log a p50/p95/p99 latency report every 5 minutes.
 *     if (process.env.PERF_REPORT_INTERVAL_MS !== "0") {
 *       setInterval(
 *         () => logLatencyReport(),
 *         Number(process.env.PERF_REPORT_INTERVAL_MS ?? 5 * 60 * 1000),
 *       ).unref();
 *     }
 *   }
 *
 * Ordering notes:
 *  - `compressionMiddleware` must run before `express.json()` and all routers
 *    so it wraps every response, including error responses.
 *  - `responseTime` should run before routers so timings include handler time.
 *  - `cacheControl` only *sets policy* for paths that have no explicit
 *    Cache-Control yet; routers can still override per-response.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

// ── 1. Compression (dynamic import with fallback) ────────────────────────────

/**
 * Returns the `compression` middleware if the package is installed,
 * otherwise a pass-through middleware. `compression` is an optional
 * dependency — production images should install it:
 *
 *     pnpm add compression && pnpm add -D @types/compression
 */
export async function compressionMiddleware(): Promise<RequestHandler> {
  try {
    // Non-literal specifier: keeps TS from requiring the (optional) module
    // and its types at compile time.
    const specifier = "compression";
    const mod = (await import(specifier)) as {
      default?: (opts?: Record<string, unknown>) => RequestHandler;
      (opts?: Record<string, unknown>): RequestHandler;
    };
    const factory = mod.default ?? mod;
    return factory({
      // Compress anything > 1KB — smaller bodies cost more CPU than they save.
      threshold: 1024,
      // level 6 is the zlib sweet spot (ratio vs CPU). Mobile CPU is the
      // constraint for *clients*, not us — server-side gzip is cheap.
      level: 6,
      // Don't re-compress already-compressed media or SSE/WebSocket upgrades.
      filter: (req: Request, res: Response) => {
        if (req.headers["x-no-compression"]) return false;
        const type = String(res.getHeader("Content-Type") ?? "");
        if (/^(image|video|audio)\//.test(type)) return false;
        return true;
      },
    });
  } catch {
    console.warn(
      "[perf] optional dependency 'compression' not installed — " +
        "responses will be served uncompressed. Install with: pnpm add compression",
    );
    return (_req: Request, _res: Response, next: NextFunction) => next();
  }
}

// ── 2. Cache-Control / ETag policy ───────────────────────────────────────────

/** Matches Vite's content-hashed output, e.g. /assets/index-B7x9Kd2.js */
const HASHED_ASSET_RE = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i;

/** Paths that must never be cached by any party. */
function isNoStorePath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/ws") ||
    pathname === "/sw.js" || // SW updates must be picked up immediately
    pathname === "/manifest.json"
  );
}

/**
 * Computes the Cache-Control value for a request path.
 * Exported for unit tests and for reuse in custom static servers.
 */
export function cachePolicyFor(pathname: string): string {
  if (isNoStorePath(pathname)) {
    // API/auth/webhook data is user-specific — never store, never share.
    return "no-store";
  }
  if (HASHED_ASSET_RE.test(pathname)) {
    // Content-hashed → safe to cache for a year, immutable.
    return "public, max-age=31536000, immutable";
  }
  if (/\.(png|jpe?g|webp|avif|svg|ico|woff2?)$/.test(pathname)) {
    // Unhashed images/fonts (e.g. /icons/*) — revalidate hourly.
    return "public, max-age=3600, stale-while-revalidate=86400";
  }
  if (pathname === "/" || pathname.endsWith(".html") || pathname === "/index.html") {
    // HTML is the deploy boundary — always revalidate so new releases ship.
    return "no-cache";
  }
  // Everything else (fonts.css, etc.) — short cache with revalidation.
  return "public, max-age=300, stale-while-revalidate=3600";
}

/**
 * Express middleware applying `cachePolicyFor` when the downstream handler
 * hasn't already set a Cache-Control header. Also enables weak ETags for
 * non-API responses (Express sets ETag automatically on res.send; this just
 * documents intent and ensures `app.set('etag', ...)` stays enabled).
 */
export function cacheControl(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const policy = cachePolicyFor(req.path);
    // Intercept at header-write time so routers can override beforehand.
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = function patchedWriteHead(
      ...args: Parameters<Response["writeHead"]>
    ) {
      if (!res.hasHeader("Cache-Control")) {
        res.setHeader("Cache-Control", policy);
      }
      if (policy !== "no-store" && !res.hasHeader("Vary")) {
        res.setHeader("Vary", "Accept-Encoding");
      }
      return originalWriteHead(...args);
    } as Response["writeHead"];
    next();
  };
}

// ── 3. Response time header + p95 tracking + budget warnings ─────────────────

/**
 * Latency budgets in milliseconds per endpoint class (p95 targets).
 * Aligned with docs/PERFORMANCE.md — exceeding a budget logs a warning.
 */
export const LATENCY_BUDGETS_MS: Record<string, number> = {
  webhook: 100, // payment/USSD webhook ack
  wallet_read: 150, // wallet balance/history reads
  auth: 300, // login, OTP send/verify
  admin_queue: 400, // admin review queue lists
  api_other: 500, // everything else under /api
  static: 50, // static assets from disk (usually CDN-fronted)
};

/** Classify a request path into a latency budget class. */
export function classifyPath(pathname: string): keyof typeof LATENCY_BUDGETS_MS {
  if (pathname.startsWith("/api/payments") || pathname.startsWith("/api/ussd"))
    return "webhook";
  if (
    pathname.startsWith("/api/trpc/wallet.balance") ||
    pathname.startsWith("/api/trpc/wallet.transactions") ||
    pathname.startsWith("/api/trpc/wallet.history")
  )
    return "wallet_read";
  if (
    pathname.startsWith("/api/trpc/auth") ||
    pathname.startsWith("/api/trpc/otp")
  )
    return "auth";
  if (
    pathname.startsWith("/api/trpc/admin") ||
    pathname.startsWith("/api/trpc/kyc.list") ||
    pathname.startsWith("/api/trpc/kyc.queue")
  )
    return "admin_queue";
  if (pathname.startsWith("/api/")) return "api_other";
  return "static";
}

/** Fixed-size ring buffer of recent latencies per class. */
const WINDOW_SIZE = 512;
const latencyWindows = new Map<string, number[]>();

function recordLatency(routeClass: string, ms: number) {
  let buf = latencyWindows.get(routeClass);
  if (!buf) {
    buf = [];
    latencyWindows.set(routeClass, buf);
  }
  buf.push(ms);
  if (buf.length > WINDOW_SIZE) buf.shift();
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** Snapshot of p50/p95/p99 latencies per endpoint class (milliseconds). */
export type LatencyStats = {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  budgetMs: number;
  overBudget: boolean;
};

export function latencyReport(): Record<string, LatencyStats> {
  const out: Record<string, LatencyStats> = {};
  for (const [routeClass, buf] of latencyWindows) {
    const sorted = [...buf].sort((a, b) => a - b);
    const p95 = percentile(sorted, 95);
    const budgetMs = LATENCY_BUDGETS_MS[routeClass] ?? 500;
    out[routeClass] = {
      count: sorted.length,
      p50: percentile(sorted, 50),
      p95,
      p99: percentile(sorted, 99),
      budgetMs,
      overBudget: p95 > budgetMs,
    };
  }
  return out;
}

/** Log the current latency report (call from a setInterval in _core/index.ts). */
export function logLatencyReport(): void {
  const report = latencyReport();
  for (const [routeClass, stats] of Object.entries(report)) {
    const flag = stats.overBudget ? " ⚠ OVER BUDGET" : "";
    console.log(
      `[perf] ${routeClass}: n=${stats.count} p50=${stats.p50}ms p95=${stats.p95}ms p99=${stats.p99}ms budget=${stats.budgetMs}ms${flag}`,
    );
  }
}

/**
 * Express middleware: measures wall-clock handler time, sets
 * `X-Response-Time`, records samples for p95 reporting, and logs a warning
 * when a request exceeds its class budget by >2x (severe) — single
 * exceedances are normal under load, but they should be visible.
 */
export function responseTime(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const rounded = Math.round(ms * 10) / 10;
      const routeClass = classifyPath(req.path);
      recordLatency(routeClass, rounded);
      const budget = LATENCY_BUDGETS_MS[routeClass] ?? 500;
      if (rounded > budget * 2) {
        console.warn(
          `[perf] SLOW ${req.method} ${req.originalUrl} took ${rounded}ms ` +
            `(class=${routeClass}, budget=${budget}ms, status=${res.statusCode})`,
        );
      }
    });
    // Set the header just before headers are written.
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = function patchedWriteHead(
      ...args: Parameters<Response["writeHead"]>
    ) {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      res.setHeader("X-Response-Time", `${ms.toFixed(1)}ms`);
      return originalWriteHead(...args);
    } as Response["writeHead"];
    next();
  };
}
