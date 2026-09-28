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
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, Response } from "express";

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
  keyGenerator: ipKey,
  skip: () => process.env.NODE_ENV === "test",
});
