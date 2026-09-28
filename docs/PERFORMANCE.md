# NigerianPass Performance Budgets & Tuning Guide

Target: **industry-standard millisecond response times, mobile included** —
for Nigerian network reality (3G/4G, mid-tier Android, intermittent connectivity).

---

## 1. Performance budgets

### Server-side latency (server-measured, excludes last-mile network)

| Endpoint class              | Examples                                   | p50     | p95     | p99     |
| --------------------------- | ------------------------------------------ | ------- | ------- | ------- |
| Webhook ack                 | `/api/payments/*`, `/api/ussd`             | ≤30 ms  | ≤100 ms | ≤200 ms |
| Wallet reads                | `wallet.balance`, `wallet.transactions`    | ≤60 ms  | ≤150 ms | ≤300 ms |
| Auth                        | `auth.login`, `otp.send`, `otp.verify`     | ≤120 ms | ≤300 ms | ≤600 ms |
| Admin review queue          | `kyc.list/queue`, `admin.*` list endpoints | ≤150 ms | ≤400 ms | ≤800 ms |
| Other tRPC queries          | devices, status, misc reads                | ≤100 ms | ≤300 ms | ≤600 ms |
| Static asset (origin disk)  | `/assets/*`                                | ≤15 ms  | ≤50 ms  | ≤100 ms |

`server/middleware/perf.ts` enforces visibility of these budgets: it sets
`X-Response-Time`, keeps an in-memory p50/p95/p99 window per class, and logs
a warning when a request exceeds 2× its class budget.

### Client / mobile

| Metric                                  | Budget                          |
| --------------------------------------- | ------------------------------- |
| Time to Interactive (3G, mid-tier Moto-class) | ≤ 3 s                     |
| First Contentful Paint (3G)             | ≤ 1.5 s                         |
| Initial JS bundle (gzip)                | ≤ 350 KB total, ≤ 170 KB entry  |
| Route-level lazy chunks                 | ≤ 100 KB gzip each              |
| API response payload (list endpoints)   | ≤ 50 KB gzip, paginated ≤ 50 rows |
| Lighthouse Performance (mobile)         | ≥ 85                            |
| Lighthouse PWA                          | installable, offline-capable    |

---

## 2. Tuning applied (this change set)

### Database — `drizzle/migrations/0010_performance_indexes.sql`

Composite and partial indexes matched to real query patterns:

| Table                | Index                                          | Query pattern                        |
| -------------------- | ---------------------------------------------- | ------------------------------------ |
| kyc_applications     | `("userId", status)`                           | user dashboard list                  |
| kyc_applications     | `(status, "createdAt")`                        | admin review queue ordering          |
| kyc_applications     | partial `(createdAt) WHERE status IN (...)`    | hot pending-review subset            |
| kyc_applications     | `lower("referenceId")`                         | case-insensitive reference lookup    |
| wallet_transactions  | `("walletId", "createdAt" DESC)`               | wallet history, newest first         |
| wallet_transactions  | UNIQUE `("externalRef") WHERE NOT NULL`        | webhook idempotency / reconciliation |
| otp_codes            | `(phone, "expiresAt" DESC)` + partial unused   | OTP verify hot path                  |
| sync_queue           | `("userId", status)` + partial pending         | offline replay status / worker       |
| ussd_sessions        | `("sessionId")`, `("phoneNumber", startedAt)`  | USSD webhook continuation (p99)      |
| qr_scan_logs         | `("deviceSerial", "scannedAt" DESC)`           | security audit                       |
| toll_devices         | `(plaza, status)` + partial attention subset   | admin device grid                    |
| device_alert_logs    | `("deviceId", "resolvedAt" DESC)`              | per-device alert history             |

`ANALYZE` statements at the end refresh planner statistics immediately.

### Server — `server/middleware/perf.ts` (new, mount in `_core/index.ts`)

- **Compression** via dynamic `import("compression")` with a no-op fallback
  (install `pnpm add compression` in production images).
- **Cache-Control policy helper**: `immutable, max-age=1y` for content-hashed
  `/assets/*`, `no-store` for all `/api/*`, `no-cache` for HTML, SWR for
  images/fonts.
- **Response-time header + p95 logging hook** + per-class budget warnings.

Mounting instructions are in the file header comment.

### Client build — `vite.config.ts`

- Manus debug collector / jsx-loc / manus-runtime plugins **disabled in
  production** (`NODE_ENV=production`) — they inject dev-only scripts and
  per-element data attributes.
- esbuild minify with `drop: ["console", "debugger"]` in prod.
- `target: "es2020"`, `cssCodeSplit`, `assetsInlineLimit: 4096`,
  `modulePreload` polyfill, `chunkSizeWarningLimit: 500`.
- `manualChunks` vendor splitting: react / trpc+query / radix / charts /
  motion / forms / icons / maps (lazy) / misc — each content-hashed and
  independently cacheable.

### Service worker — `client/public/sw.js`

- Versioned caches (`np-precache-v2`, `np-static-v2`, `np-api-v2`) with
  cleanup of old versions on activate; `skipWaiting` + `clients.claim()`.
- Precache app shell + `offline.html` + icons.
- **Stale-while-revalidate** for static assets and CDN/font origins.
- **Network-first with 60s TTL cache fallback** for `/api/trpc` GET queries
  (8s network timeout; stale data served when offline — a stale balance beats
  an error screen in a tunnel).
- **Network-only** for mutations and webhooks (payments/USSD/OAuth).
- Runtime caches bounded (120 static / 60 API entries, FIFO eviction).
- Background-sync tags preserved: `np-retry-queue`, `np-balance-refresh`,
  `np-kyc-status-sync` (+ periodic variants) — compatible with the existing
  IndexedDB `retry_queue` replay code.

### HTML/manifest

- Preconnect + dns-prefetch for fonts, maps, and the CDN origin.
- Fonts loaded non-blocking (`media="print" onload` pattern + preload) —
  a slow font CDN can no longer delay first paint.
- Deduplicated meta tags; `viewport-fit=cover`; pinch-zoom re-enabled.
- Manifest icons switched to **local** `/icons/*.png` (installable offline;
  remote CloudFront icons broke installability without connectivity).

---

## 3. Server-side guidance

- **DB pool**: size `pg` pool to ~`(2 × vCPU) + spindles`; start with
  `max: 10` per instance, `idleTimeoutMillis: 30_000`,
  `connectionTimeoutMillis: 5_000`. Watch `pg_stat_activity` for saturation.
- **Redis caching**: cache hot, slow-changing reads with short TTLs —
  wallet balance (30–60s, invalidate on transaction), toll device lists
  (60s), admin queue counts (15–30s). Never cache OTP or auth tokens.
- **N+1 avoidance in routers**: batch child lookups with `inArray(...)`
  instead of per-row queries; use drizzle relational queries or a single
  JOIN for list endpoints. Review any `.map(async ...)` over DB calls.
- **Pagination**: every list endpoint must take `limit` (≤50) + cursor;
  never return unbounded lists. Keyset pagination (`WHERE "createdAt" < $1`)
  beats `OFFSET` on the admin queue.
- **Webhooks**: ack first (≤100 ms budget), process async via the job queue.
  Payment providers retry on slow acks, which causes duplicate work.

## 4. Mobile / PWA guidance

- **Lazy routes**: all non-landing routes should be `React.lazy()` —
  charts, motion, maps chunks are already split for this.
- **Image sizing**: serve WebP/AVIF at device-appropriate widths; never ship
  >100 KB images on 3G. Use `loading="lazy"` below the fold.
- **Data-saver mode**: respect `navigator.connection.saveData` and
  `effectiveType` — skip polling, prefetch, and heavy animations; lengthen
  balance-refresh intervals; the SW already caps cache growth.
- **Offline-first mutations**: keep queueing KYC/payment mutations in
  IndexedDB and let the `np-retry-queue` background-sync tag replay them.

## 5. Measurement plan

- **Lighthouse CI**: run on PR against the production build with mobile
  throttling (simulated 3G, 4× CPU). Fail the build if performance < 85 or
  initial JS > 350 KB gzip (`bundlesize` / `size-limit`).
- **k6 load test sketch**:

  ```js
  import http from "k6/http";
  import { check } from "k6";
  export const options = { vus: 50, duration: "2m" };
  const BASE = __ENV.BASE_URL;
  export default function () {
    check(http.get(`${BASE}/api/trpc/wallet.balance`, { headers }),
      { "wallet p95 budget": (r) => r.timings.duration < 150 });
    check(http.get(`${BASE}/api/trpc/kyc.myApplications`, { headers }),
      { "kyc budget": (r) => r.timings.duration < 300 });
  }
  ```

  Track `http_req_duration{p(95)}` per endpoint group against §1 budgets.
- **Prometheus metrics**: expose `/metrics` from the infra metrics module
  (prom-client): histogram `http_request_duration_ms{route_class}` matching
  the classes in `perf.ts`, plus `pg_pool_connections_active` and
  `redis_cache_hits_total`. Alert when p95 exceeds budget for 5 minutes.
- **Runtime visibility**: `PERF_REPORT_INTERVAL_MS=300000` logs a p50/p95/p99
  report per endpoint class every 5 minutes from `perf.ts`.
