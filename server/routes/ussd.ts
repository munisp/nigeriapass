/**
 * Africa's Talking USSD Webhook Route
 * ======================================
 * Handles real handset USSD sessions from the Africa's Talking gateway.
 *
 * AT posts form-encoded data to this endpoint on every user keypress:
 *   POST /api/ussd/session
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: sessionId=&serviceCode=*346%23&phoneNumber=%2B234...&text=1*2
 *
 * Response must be plain text:
 *   "CON <menu text>"  → session continues (user sees menu)
 *   "END <final text>" → session ends (user sees message, call drops)
 *
 * Signature Verification (when AT_USSD_WEBHOOK_SECRET is set):
 *   AT sends X-AT-Signature header = HMAC-SHA256(secret, rawBody)
 *   We verify this before processing any input.
 *
 * Shortcode Configuration:
 *   Production:  AT_USSD_SHORTCODE=*346#
 *   Sandbox:     AT_USSD_SHORTCODE=*384*346#  (AT sandbox prefix)
 */
import { Router, Request, Response } from "express";
import crypto from "crypto";
import { ENV } from "../_core/env.js";
import { processUssdInput } from "../routers/ussd.js";
import { getDb, getUserByPhone } from "../db.js";

/** Fire-and-forget: update ussd_sessions row after each response */
async function persistUssdResponse(
  sessionId: string,
  response: string,
  interactionCount: number,
  sessionStartedAt: number,
  menuPath: string,
): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    const { ussdSessions } = await import("../../drizzle/schema.js");
    const { eq } = await import("drizzle-orm");
    const isEnd = response.startsWith("END");
    const now = new Date();
    if (isEnd) {
      const durationSeconds = Math.round((Date.now() - sessionStartedAt) / 1000);
      await db.update(ussdSessions)
        .set({ completed: true, menuPath, interactionCount, durationSeconds, endedAt: now })
        .where(eq(ussdSessions.sessionId, sessionId));
    } else {
      await db.update(ussdSessions)
        .set({ interactionCount })
        .where(eq(ussdSessions.sessionId, sessionId));
    }
  } catch (err) {
    console.warn("[USSD] Failed to persist response:", err);
  }
}

/** In-memory map to track session start times for duration calculation */
const sessionStartTimes = new Map<string, number>();

export const ussdWebhookRouter = Router();

// ── Signature verification middleware ─────────────────────────────────────────
function verifyAtSignature(req: Request, res: Response, next: () => void) {
  const secret = ENV.atUssdWebhookSecret;
  if (!secret) {
    // No secret configured → skip verification (dev/sandbox mode)
    return next();
  }
  const signature = req.headers["x-at-signature"] as string | undefined;
  if (!signature) {
    res.status(401).send("Missing X-AT-Signature header");
    return;
  }
  // Compute expected HMAC-SHA256 over the raw body
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    res.status(400).send("Missing raw body");
    return;
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  // Constant-time comparison to prevent timing attacks
  const sigBuf = Buffer.from(signature, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    res.status(401).send("Invalid signature");
    return;
  }
  next();
}

// ── Raw body capture for HMAC verification ────────────────────────────────────
// server/_core/index.ts mounts express.urlencoded({ verify }) for /api/ussd
// BEFORE the global body parser, so req.rawBody is normally already present.
// This fallback only runs when the router is used standalone (tests).
ussdWebhookRouter.use((req, _res, next) => {
  if ((req as Request & { rawBody?: Buffer }).rawBody) return next();
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    (req as Request & { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
    next();
  });
});

// ── POST /api/ussd/session — Africa's Talking USSD gateway callback ───────────
ussdWebhookRouter.post(
  "/session",
  verifyAtSignature,
  async (req: Request, res: Response) => {
    try {
      // AT sends form-encoded body — parse from rawBody we captured above
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
      const bodyStr = rawBody?.toString("utf8") ?? "";
      const params = new URLSearchParams(bodyStr);

      const sessionId = params.get("sessionId") ?? "";
      const serviceCode = params.get("serviceCode") ?? "";
      const phoneNumber = params.get("phoneNumber") ?? "";
      const text = params.get("text") ?? "";

      if (!sessionId || !phoneNumber) {
        res.status(400).send("END Missing required parameters");
        return;
      }

      // Log incoming request (sanitized — no full phone number in logs)
      const maskedPhone = phoneNumber.replace(/(\+\d{3})\d+(\d{3})/, "$1****$2");
      console.log(`[USSD] Session ${sessionId} | Phone ${maskedPhone} | Code ${serviceCode} | Text "${text}"`);

      // Resolve the user by phone (openId convention "phone:<msisdn>") so
      // balance/statement flows operate on the correct wallet (audit v13, P0-10).
      if (!sessionStartTimes.has(sessionId)) {
        sessionStartTimes.set(sessionId, Date.now());
      }
      let linkedUserId: string | undefined;
      try {
        const user = await getUserByPhone(phoneNumber);
        if (user) linkedUserId = String(user.id);
      } catch {
        // Non-fatal — unlinked phones still get the public menus
      }
      const response = await processUssdInput(sessionId, phoneNumber, text, linkedUserId, serviceCode);

      // Persist session state asynchronously (fire-and-forget)
      const startedAt = sessionStartTimes.get(sessionId) ?? Date.now();
      const interactionCount = (text ? text.split("*").filter(Boolean).length : 0) + 1;
      const menuPath = text ? text.split("*").filter(Boolean).join("|") : "root";
      void persistUssdResponse(sessionId, response, interactionCount, startedAt, menuPath);

      // Clean up start time tracking when session ends
      if (response.startsWith("END")) {
        sessionStartTimes.delete(sessionId);
      }

      // AT expects plain text response
      res.set("Content-Type", "text/plain");
      res.send(response);
    } catch (err) {
      console.error("[USSD] Webhook error:", err);
      res.set("Content-Type", "text/plain");
      res.send("END Service temporarily unavailable. Please try again later.");
    }
  }
);

// ── POST /api/ussd/test-handset — QA simulation harness ─────────────────────
// Simulates a full Africa's Talking USSD callback sequence from a test phone
// number, allowing QA engineers to run end-to-end handset simulations from
// the admin portal without needing a physical SIM or AT sandbox account.
ussdWebhookRouter.post("/test-handset", async (req: Request, res: Response) => {
  try {
    const { phoneNumber, steps } = req.body as {
      phoneNumber?: string;
      steps?: string[];
    };
    if (!phoneNumber || !Array.isArray(steps) || steps.length === 0) {
      res.status(400).json({
        error: "phoneNumber (string) and steps (string[]) are required",
        example: { phoneNumber: "+2348012345678", steps: ["", "1", "1"] },
      });
      return;
    }
    if (!/^\+234[789]\d{9}$/.test(phoneNumber)) {
      res.status(400).json({ error: "phoneNumber must be a valid Nigerian number (+234XXXXXXXXXX)" });
      return;
    }
    const sessionId = `TEST-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const results: Array<{ step: number; input: string; response: string; type: "CON" | "END" }> = [];
    let sessionEnded = false;
    for (let i = 0; i < steps.length; i++) {
      if (sessionEnded) break;
      const input = steps[i];
      const accumulatedText = steps.slice(0, i + 1).filter(s => s !== "").join("*");
      const response = await processUssdInput(sessionId, phoneNumber, accumulatedText);
      const type = response.startsWith("END") ? "END" : "CON";
      results.push({ step: i + 1, input, response, type });
      if (type === "END") sessionEnded = true;
    }
    res.json({
      sessionId,
      phoneNumber: phoneNumber.replace(/(\+\d{3})\d+(\d{3})/, "$1****$2"),
      shortcode: ENV.atUssdShortcode,
      totalSteps: results.length,
      sessionEnded,
      results,
    });
  } catch (err) {
    console.error("[USSD] Test harness error:", err);
    res.status(500).json({ error: "Test harness failed", detail: String(err) });
  }
});

// ── GET /api/ussd/health — Shortcode configuration health check ───────────────
ussdWebhookRouter.get("/health", (_req: Request, res: Response) => {
  const hasSecret = Boolean(ENV.atUssdWebhookSecret);
  const isDemoMode = !ENV.atApiKey || ENV.atApiKey === "demo";
  res.json({
    status: "ok",
    shortcode: ENV.atUssdShortcode,
    signatureVerification: hasSecret ? "enabled" : "disabled (no AT_USSD_WEBHOOK_SECRET)",
    mode: isDemoMode ? "demo" : "live",
    username: ENV.atUsername || "(not set)",
    timestamp: new Date().toISOString(),
  });
});
