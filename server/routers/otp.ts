/**
 * OTP Router
 * ==========
 * tRPC procedures for SMS OTP phone-number login.
 *
 * Procedures:
 *  - otp.send   — Send a 6-digit OTP to a phone number via Africa's Talking
 *  - otp.verify — Verify the submitted code and return a session token
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { sendOtp, verifyOtp } from "../services/otp";
import { upsertUser, getUserByOpenId } from "../db";
import { getSessionCookieOptions } from "../_core/cookies";
import { SignJWT } from "jose";
import { ENV } from "../_core/env";
import { COOKIE_NAME } from "../../shared/const";

// E.164 phone number regex (Nigerian numbers: +234XXXXXXXXXX)
const phoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, "Phone must be in E.164 format (e.g. +2348012345678)");

export const otpRouter = router({
  /**
   * Send an OTP to the given phone number.
   * Rate-limited at the Express middleware level (5 req/15min per IP).
   */
  send: publicProcedure
    .input(
      z.object({
        phone: phoneSchema,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const requestIp =
        ctx.req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ??
        ctx.req.socket?.remoteAddress ??
        "unknown";

      try {
        const result = await sendOtp(input.phone, requestIp);
        return result;
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: (err as Error).message,
        });
      }
    }),

  /**
   * Verify the submitted OTP code.
   * On success, upserts the user (phone as openId) and sets a session cookie.
   */
  verify: publicProcedure
    .input(
      z.object({
        phone: phoneSchema,
        code: z.string().length(6).regex(/^\d{6}$/, "Code must be 6 digits"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const result = await verifyOtp(input.phone, input.code);

      if (!result.success) {
        const messages: Record<string, string> = {
          expired: "Code has expired. Please request a new one.",
          invalid: `Incorrect code. ${result.attemptsLeft ?? 0} attempt(s) remaining.`,
          used: "This code has already been used.",
          max_attempts: "Too many failed attempts. Please request a new code.",
          not_found: "No active code found. Please request a new one.",
        };
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: messages[result.error ?? "invalid"] ?? "Verification failed.",
        });
      }

      // Upsert user — phone number is the openId for phone-login users
      const openId = `phone:${input.phone}`;
      await upsertUser({
        openId,
        name: input.phone,
        loginMethod: "sms_otp",
        lastSignedIn: new Date(),
      });

      const user = await getUserByOpenId(openId);
      if (!user) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create user session.",
        });
      }

      // Issue a JWT session cookie (same format as Manus OAuth sessions)
      const secret = new TextEncoder().encode(ENV.cookieSecret);
      const token = await new SignJWT({
        sub: String(user.id),
        openId: user.openId,
        name: user.name ?? input.phone,
        email: user.email ?? null,
        role: user.role,
        loginMethod: "sms_otp",
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("7d")
        .sign(secret);

      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.cookie(COOKIE_NAME, token, {
        ...cookieOptions,
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      return {
        success: true,
        user: {
          id: user.id,
          openId: user.openId,
          name: user.name,
          role: user.role,
          loginMethod: "sms_otp" as const,
        },
      };
    }),
});
