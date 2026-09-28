import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { setupWebSocketServer } from "../websocket";
import { setupDeviceHeartbeatServer } from "../deviceHeartbeat";
import { paymentsRouter } from "../routes/payments";
import { ussdWebhookRouter } from "../routes/ussd";
import { startReconciliationScheduler } from "../jobs/reconcile";
import {
  otpSendLimiter,
  otpVerifyLimiter,
  paymentInitiateLimiter,
  authLimiter,
  generalApiLimiter,
} from "../middleware/rateLimiter";
import {
  compressionMiddleware,
  cacheControl,
  responseTime,
  logLatencyReport,
} from "../middleware/perf";
import {
  httpMetricsMiddleware,
  metricsExpressHandler,
} from "../integrations/metrics";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

/** Stash the raw request body buffer for HMAC verification (webhooks). */
function stashRawBody(
  req: express.Request & { rawBody?: Buffer },
  _res: express.Response,
  buf: Buffer,
) {
  if (buf && buf.length > 0) req.rawBody = Buffer.from(buf);
}

/** Helmet-style security headers (no external dependency). */
function securityHeaders(_req: express.Request, res: express.Response, next: express.NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=(self)");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );
  next();
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  app.use(securityHeaders);

  // ── Performance middleware (audit v13) ────────────────────────────────────
  // Must precede body parsers/routers so every response is timed & compressed.
  app.use(await compressionMiddleware());
  app.use(responseTime());
  app.use(cacheControl());
  app.use(httpMetricsMiddleware);
  app.get("/metrics", metricsExpressHandler);
  if (process.env.PERF_REPORT_INTERVAL_MS !== "0") {
    setInterval(
      () => logLatencyReport(),
      Number(process.env.PERF_REPORT_INTERVAL_MS ?? 5 * 60 * 1000),
    ).unref();
  }

  // ── Raw-body capture MUST precede the global JSON parser (audit v13, P0-3) ──
  // HMAC signatures for payment/USSD webhooks are computed over the exact raw
  // payload. Registering express.json({ verify }) for these paths first both
  // parses the body AND stashes the untouched buffer on req.rawBody.
  app.use("/api/payments", express.json({ limit: "2mb", verify: stashRawBody }));
  app.use("/api/ussd", express.urlencoded({ limit: "1mb", extended: true, verify: stashRawBody }));

  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);

  // ── Rate limiting ─────────────────────────────────────────────────────────
  // OTP endpoints — keyed on IP + phone to prevent per-number SMS abuse
  app.use("/api/trpc/otp.send", otpSendLimiter);
  app.use("/api/trpc/otp.verify", otpVerifyLimiter);
  // Auth endpoints — login, register, logout
  app.use("/api/trpc/auth", authLimiter);
  // Payment initiation is tRPC-only (wallet.initiateTopup) — the legacy
  // POST /api/payments/initiate handlers were removed (audit v13, P0-5).
  app.use("/api/trpc/wallet.initiateTopup", paymentInitiateLimiter);
  app.use("/api/trpc/wallet.chargeToll", paymentInitiateLimiter);
  // General API — generous limit for PWA background syncs
  app.use("/api/trpc", generalApiLimiter);

  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // WebSocket server for live KYC status push
  setupWebSocketServer(server);
  // WebSocket server for real-time device heartbeat streaming
  setupDeviceHeartbeatServer(server);

  // Unified payment webhook — handles Paystack, Flutterwave, Interswitch.
  // req.rawBody was already stashed by the express.json({ verify }) middleware
  // registered BEFORE the global parser above.
  app.use("/api/payments", paymentsRouter);

  // Africa's Talking USSD webhook — real handset sessions from *346# shortcode
  // Raw body is captured inside ussdWebhookRouter for HMAC-SHA256 verification
  app.use("/api/ussd", ussdWebhookRouter);

  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    // Start the nightly payment reconciliation scheduler
    startReconciliationScheduler();
  });
}

startServer().catch(console.error);
