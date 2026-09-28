import { z } from "zod";

/**
 * Centralised environment configuration with boot-time validation.
 *
 * Fail-closed policy (production only):
 *  - JWT_SECRET must be set (session signing key).
 *  - NFC_MASTER_SECRET must be set (no hardcoded fallbacks anywhere).
 *  - At least the configured payment providers' secrets must be real
 *    (values containing "demo" are rejected in production).
 *
 * In development/test, missing secrets are tolerated so local tooling and
 * the Vitest suite can run without credentials — demo behaviour is then
 * gated behind NODE_ENV !== "production" at the call site.
 */

const envSchema = z.object({
  VITE_APP_ID: z.string().default(""),
  JWT_SECRET: z.string().default(""),
  DATABASE_URL: z.string().optional(),
  POSTGRES_URL: z.string().optional(),
  OAUTH_SERVER_URL: z.string().default(""),
  OWNER_OPEN_ID: z.string().default(""),
  BUILT_IN_FORGE_API_URL: z.string().default(""),
  BUILT_IN_FORGE_API_KEY: z.string().default(""),

  PAYSTACK_SECRET_KEY: z.string().default(""),
  FLUTTERWAVE_SECRET_KEY: z.string().default(""),
  INTERSWITCH_MAC_KEY: z.string().default(""),
  INTERSWITCH_CLIENT_ID: z.string().default(""),
  INTERSWITCH_CLIENT_SECRET: z.string().default(""),
  INTERSWITCH_BASE_URL: z.string().default("https://sandbox.interswitchng.com"),
  INTERSWITCH_PRODUCT_ID: z.string().default(""),

  AT_API_KEY: z.string().optional(),
  AFRICASTALKING_API_KEY: z.string().optional(),
  AT_USERNAME: z.string().optional(),
  AFRICASTALKING_USERNAME: z.string().optional(),
  AT_SENDER_ID: z.string().default("NigerianPass"),
  AT_USSD_SHORTCODE: z.string().default("*346#"),
  AT_USSD_WEBHOOK_SECRET: z.string().default(""),

  NFC_MASTER_SECRET: z.string().default(""),
  NFC_VALIDATION_SERVICE_URL: z.string().default("http://localhost:9090"),

  REDIS_URL: z.string().default(""),
  DEVICE_HEARTBEAT_SECRET: z.string().default(""),
});

const parsed = envSchema.parse(process.env);

const isProduction = process.env.NODE_ENV === "production";

function looksDemo(value: string): boolean {
  return /demo|test|changeme|placeholder/i.test(value);
}

if (isProduction) {
  const missing: string[] = [];
  if (!parsed.JWT_SECRET) missing.push("JWT_SECRET");
  if (!parsed.NFC_MASTER_SECRET) missing.push("NFC_MASTER_SECRET");
  if (!parsed.DATABASE_URL && !parsed.POSTGRES_URL) missing.push("DATABASE_URL");
  // Payment secrets: at least one provider must be fully configured with a
  // non-demo secret, otherwise card payments would silently fail open.
  const paymentSecrets = [
    parsed.PAYSTACK_SECRET_KEY,
    parsed.FLUTTERWAVE_SECRET_KEY,
    parsed.INTERSWITCH_CLIENT_SECRET,
  ];
  if (!paymentSecrets.some(s => s && !looksDemo(s))) {
    missing.push("PAYSTACK_SECRET_KEY|FLUTTERWAVE_SECRET_KEY|INTERSWITCH_CLIENT_SECRET (at least one real secret)");
  }
  for (const [name, value] of [
    ["JWT_SECRET", parsed.JWT_SECRET],
    ["NFC_MASTER_SECRET", parsed.NFC_MASTER_SECRET],
    ["PAYSTACK_SECRET_KEY", parsed.PAYSTACK_SECRET_KEY],
    ["FLUTTERWAVE_SECRET_KEY", parsed.FLUTTERWAVE_SECRET_KEY],
    ["INTERSWITCH_CLIENT_SECRET", parsed.INTERSWITCH_CLIENT_SECRET],
  ] as const) {
    if (value && looksDemo(value)) {
      missing.push(`${name} (demo-looking value is not allowed in production)`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[ENV] Refusing to boot in production — missing/invalid required environment variables:\n  - ${missing.join("\n  - ")}`
    );
  }
}

export const ENV = {
  // Core platform
  appId: parsed.VITE_APP_ID,
  cookieSecret: parsed.JWT_SECRET,
  databaseUrl: parsed.DATABASE_URL ?? parsed.POSTGRES_URL ?? "",
  oAuthServerUrl: parsed.OAUTH_SERVER_URL,
  ownerOpenId: parsed.OWNER_OPEN_ID,
  isProduction,
  forgeApiUrl: parsed.BUILT_IN_FORGE_API_URL,
  forgeApiKey: parsed.BUILT_IN_FORGE_API_KEY,

  // Payment gateways
  paystackSecretKey: parsed.PAYSTACK_SECRET_KEY,
  flutterwaveSecretKey: parsed.FLUTTERWAVE_SECRET_KEY,
  interswitchMacKey: parsed.INTERSWITCH_MAC_KEY,
  interswitchClientId: parsed.INTERSWITCH_CLIENT_ID,
  interswitchClientSecret: parsed.INTERSWITCH_CLIENT_SECRET,
  interswitchBaseUrl: parsed.INTERSWITCH_BASE_URL,
  interswitchProductId: parsed.INTERSWITCH_PRODUCT_ID,

  // Africa's Talking (SMS / USSD)
  atApiKey: parsed.AT_API_KEY ?? parsed.AFRICASTALKING_API_KEY ?? "",
  atUsername: parsed.AT_USERNAME ?? parsed.AFRICASTALKING_USERNAME ?? "",
  atSenderId: parsed.AT_SENDER_ID,
  /** AT USSD shortcode — e.g. *346# for production, *384*346# for sandbox */
  atUssdShortcode: parsed.AT_USSD_SHORTCODE,
  /** AT USSD webhook secret for HMAC-SHA256 signature verification */
  atUssdWebhookSecret: parsed.AT_USSD_WEBHOOK_SECRET,

  // NFC / HSM
  nfcMasterSecret: parsed.NFC_MASTER_SECRET,
  nfcValidationServiceUrl: parsed.NFC_VALIDATION_SERVICE_URL,

  // Infrastructure
  redisUrl: parsed.REDIS_URL,
  /** Shared secret used to authenticate toll-device heartbeat connections */
  deviceHeartbeatSecret: parsed.DEVICE_HEARTBEAT_SECRET,
};
