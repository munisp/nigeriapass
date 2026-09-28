import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { protectedProcedure, publicProcedure, router } from "./_core/trpc";
import { sdk } from "./_core/sdk";
import { revokeSession, revokeAllSessionsForUser } from "./db";
import { audit } from "./_core/audit";
import { syncRouter } from "./routers/sync";
import { adminRouter } from "./routers/admin";
import { otpRouter } from "./routers/otp";
import { walletRouter } from "./routers/wallet";
import { kycRouter } from "./routers/kyc";
import { ussdRouter } from "./routers/ussd";
import { nfcRouter } from "./routers/nfc";
import { nfcBatchRouter } from "./routers/nfcBatch";
import { devicesRouter } from "./routers/devices";
import { dataRightsRouter } from "./routers/dataRights";
import { etagRouter } from "./routers/etag";
import { lanesRouter } from "./routers/lanes";
import { posRouter } from "./routers/pos";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(async ({ ctx }) => {
      // Revoke the current session server-side (P1-18) — the JWT is no longer
      // accepted even if the cookie is replayed before its natural expiry.
      try {
        const sessionToken = sdk.getSessionTokenFromCookie(ctx.req);
        if (sessionToken) {
          const payload = await sdk.verifySession(sessionToken);
          if (payload?.jti) await revokeSession(payload.jti);
          if (ctx.user) {
            void audit(ctx, "auth.logout", "user", ctx.user.id, {});
          }
        }
      } catch {
        // Best-effort revocation — still clear the cookie
      }
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
    /** Revoke ALL sessions for the current user (P1-18). */
    logoutAll: protectedProcedure.mutation(async ({ ctx }) => {
      const revoked = await revokeAllSessionsForUser(ctx.user.id);
      void audit(ctx, "auth.logoutAll", "user", ctx.user.id, { revokedSessions: revoked });
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true, revokedSessions: revoked } as const;
    }),
  }),

  // Background Sync router — used by service worker and app
  sync: syncRouter,
  // Admin KYC review router — protected by admin role check
  admin: adminRouter,
  // SMS OTP phone-number login — Africa's Talking integration
  otp: otpRouter,
  // Wallet balance and transaction history — PostgreSQL-backed
  wallet: walletRouter,
  // KYC/KYB application submission — Fleet KYB, Vehicle Registration, status lookup
  kyc: kycRouter,
  // USSD *346# session handler — Africa's Talking gateway + browser simulator
  ussd: ussdRouter,
  // NFC tag provisioning — server-side HKDF key derivation for MIFARE DESFire tags
  nfc: nfcRouter,
  // NFC batch provisioning — CSV upload for bulk HKDF key generation
  nfcBatch: nfcBatchRouter,
  // Toll device management — full CRUD for hardware devices at toll plazas
  devices: devicesRouter,
  // NDPR data rights — export, erasure, consent management
  dataRights: dataRightsRouter,
  // eTag/RFID tag lifecycle — issue, activate, suspend, replace, wallet linking
  etag: etagRouter,
  // RFID lane middleware — lane-controller ingest, charging pipeline, plaza ops
  lanes: lanesRouter,
  // Card-POS middleware — terminal management, card-txn ingest, offline sync, reversals
  pos: posRouter,
});

export type AppRouter = typeof appRouter;
