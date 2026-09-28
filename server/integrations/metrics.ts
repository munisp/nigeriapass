/**
 * Metrics & tracing — Prometheus registry + OpenTelemetry bootstrap.
 *
 * NOT A CONTAINER: this module is pure in-process instrumentation, designed to
 * be mounted by whoever owns server/_core/index.ts:
 *
 *   app.get("/metrics", metricsExpressHandler);
 *   app.use(httpMetricsMiddleware);
 *   initTracing(); // before other imports take hold, ideally first
 *
 * prom-client / @opentelemetry/* are OPTIONAL dependencies: when absent the
 * module degrades to no-ops so instrumentation never blocks a boot.
 *
 * Env: METRICS_ENABLED=true (gate the /metrics route), OTEL_EXPORTER_OTLP_ENDPOINT
 * (e.g. http://otel-collector:4318), OTEL_SERVICE_NAME.
 */

import type { NextFunction, Request, Response } from "express";
import { importOptional, logOnce, parseEnvOrNull, z } from "./_common";

const envSchema = z.object({
  METRICS_ENABLED: z.literal("true").optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().min(1).optional(),
  OTEL_SERVICE_NAME: z.string().min(1).optional(),
});

function env() {
  return parseEnvOrNull(envSchema, process.env, "Metrics");
}

// ── Structural prom-client types (package optional) ───────────────────────────

interface CounterLike {
  inc(labels?: Record<string, string>, value?: number): void;
}
interface HistogramLike {
  observe(labels: Record<string, string>, value: number): void;
  startTimer(labels?: Record<string, string>): (labels?: Record<string, string>) => number;
}
interface GaugeLike {
  set(labels: Record<string, string>, value: number): void;
}
interface RegistryLike {
  metrics(): Promise<string>;
  contentType: string;
  registerMetric(metric: unknown): void;
}
interface PromClientModule {
  Registry: new () => RegistryLike;
  Counter: new (opts: { name: string; help: string; labelNames?: string[]; registers?: RegistryLike[] }) => CounterLike;
  Histogram: new (opts: {
    name: string;
    help: string;
    labelNames?: string[];
    buckets?: number[];
    registers?: RegistryLike[];
  }) => HistogramLike;
  Gauge: new (opts: { name: string; help: string; labelNames?: string[]; registers?: RegistryLike[] }) => GaugeLike;
  collectDefaultMetrics(opts: { register: RegistryLike }): void;
}

interface MetricsBundle {
  registry: RegistryLike;
  httpDuration: HistogramLike;
  trpcDuration: HistogramLike;
  dbPool: GaugeLike;
  webhooks: CounterLike;
}

let _bundle: MetricsBundle | null | undefined;

/**
 * Lazily build the registry + standard instruments. Returns null when
 * prom-client is not installed — every helper below then no-ops.
 */
async function bundle(): Promise<MetricsBundle | null> {
  if (_bundle !== undefined) return _bundle;
  const prom = await importOptional<PromClientModule>("prom-client", "Metrics");
  if (!prom || typeof prom.Registry !== "function") {
    _bundle = null;
    return null;
  }
  const registry = new prom.Registry();
  prom.collectDefaultMetrics({ register: registry });
  const httpDuration = new prom.Histogram({
    name: "np_http_request_duration_seconds",
    help: "HTTP request latency by route",
    labelNames: ["method", "route", "status_code"],
    buckets: [0.005, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 10],
    registers: [registry],
  });
  const trpcDuration = new prom.Histogram({
    name: "np_trpc_procedure_duration_seconds",
    help: "tRPC procedure latency",
    labelNames: ["procedure", "type", "ok"],
    buckets: [0.005, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });
  const dbPool = new prom.Gauge({
    name: "np_db_pool_clients",
    help: "pg pool state",
    labelNames: ["state"], // total | idle | waiting
    registers: [registry],
  });
  const webhooks = new prom.Counter({
    name: "np_payment_webhooks_total",
    help: "Payment webhook outcomes",
    labelNames: ["provider", "event", "outcome"], // outcome: ok|duplicate|invalid_signature|error
    registers: [registry],
  });
  _bundle = { registry, httpDuration, trpcDuration, dbPool, webhooks };
  return _bundle;
}

/** Normalize Express route paths to keep label cardinality bounded. */
function normalizeRoute(req: Request): string {
  const routePath = (req.route as { path?: string } | undefined)?.path;
  const base = req.baseUrl || "";
  if (typeof routePath === "string") return base + routePath;
  // Fallback: collapse numeric/UUID segments to avoid cardinality explosions.
  return (base + req.path).replace(/\/\d+/g, "/:id").replace(/\/[0-9a-f-]{20,}/gi, "/:id").slice(0, 80);
}

/** Express middleware: records HTTP latency per route. */
export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    void bundle().then((b) => {
      if (!b) return;
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      b.httpDuration.observe({ method: req.method, route: normalizeRoute(req), status_code: String(res.statusCode) }, seconds);
    });
  });
  next();
}

/** tRPC-friendly observer: wrap procedure timing in middleware and report here. */
export async function observeTrpcProcedure(procedure: string, type: "query" | "mutation", ok: boolean, durationSeconds: number): Promise<void> {
  const b = await bundle();
  b?.trpcDuration.observe({ procedure, type, ok: String(ok) }, durationSeconds);
}

/** Report pg Pool state (call on an interval from the server bootstrap). */
export async function reportDbPool(pool: { totalCount: number; idleCount: number; waitingCount: number }): Promise<void> {
  const b = await bundle();
  if (!b) return;
  b.dbPool.set({ state: "total" }, pool.totalCount);
  b.dbPool.set({ state: "idle" }, pool.idleCount);
  b.dbPool.set({ state: "waiting" }, pool.waitingCount);
}

/** Count a payment webhook outcome (call from server/payments webhook handlers). */
export async function countWebhook(provider: "paystack" | "flutterwave" | "interswitch", event: string, outcome: "ok" | "duplicate" | "invalid_signature" | "error"): Promise<void> {
  const b = await bundle();
  b?.webhooks.inc({ provider, event, outcome });
}

/**
 * Express handler for GET /metrics. Returns 404 when METRICS_ENABLED is not
 * "true" so the endpoint is opt-in per environment.
 */
export async function metricsExpressHandler(_req: Request, res: Response): Promise<void> {
  if (env()?.METRICS_ENABLED !== "true") {
    res.status(404).end();
    return;
  }
  const b = await bundle();
  if (!b) {
    res.status(503).type("text/plain").end("# prom-client not installed\n");
    return;
  }
  res.set("content-type", b.registry.contentType);
  res.end(await b.registry.metrics());
}

// ── OpenTelemetry tracing ─────────────────────────────────────────────────────

let _otelStarted = false;

/**
 * Initialize OpenTelemetry tracing via OTLP/HTTP when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set and @opentelemetry/sdk-node is installed.
 * Otherwise a no-op with a single info log. Call early in server bootstrap.
 */
export async function initTracing(): Promise<boolean> {
  if (_otelStarted) return true;
  const endpoint = env()?.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    logOnce("otel:off", "info", "[Metrics] OTEL_EXPORTER_OTLP_ENDPOINT unset — tracing disabled");
    return false;
  }
  const sdkMod = await importOptional<{ NodeSDK: new (opts: Record<string, unknown>) => { start(): void } }>(
    "@opentelemetry/sdk-node",
    "Metrics",
  );
  const exporterMod = await importOptional<{ OTLPTraceExporter: new (opts: { url: string }) => unknown }>(
    "@opentelemetry/exporter-trace-otlp-http",
    "Metrics",
  );
  if (!sdkMod || !exporterMod) return false;
  try {
    const sdk = new sdkMod.NodeSDK({
      serviceName: env()?.OTEL_SERVICE_NAME ?? "nigerianpass-api",
      traceExporter: new exporterMod.OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }),
    });
    sdk.start();
    _otelStarted = true;
    return true;
  } catch (err) {
    logOnce("otel:fail", "warn", `[Metrics] tracing init failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
