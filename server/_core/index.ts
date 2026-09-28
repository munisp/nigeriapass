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

async function startServer() {
  const app = express();
  const server = createServer(app);
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
  // Payment initiate — prevent checkout spam
  app.use("/api/payments/initiate", paymentInitiateLimiter);
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

  // Unified payment webhook — handles Paystack, Flutterwave, Interswitch
  // Raw body capture middleware for HMAC verification
  app.use("/api/payments", (req, _res, next) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
      next();
    });
  }, paymentsRouter);

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
