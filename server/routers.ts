import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { syncRouter } from "./routers/sync";
import { adminRouter } from "./routers/admin";
import { otpRouter } from "./routers/otp";
import { walletRouter } from "./routers/wallet";
import { kycRouter } from "./routers/kyc";
import { ussdRouter } from "./routers/ussd";
import { nfcRouter } from "./routers/nfc";
import { nfcBatchRouter } from "./routers/nfcBatch";
import { devicesRouter } from "./routers/devices";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
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
});

export type AppRouter = typeof appRouter;
