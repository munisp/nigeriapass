export const ENV = {
  // Core platform
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? process.env.POSTGRES_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",

  // Payment gateways
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY ?? "",
  flutterwaveSecretKey: process.env.FLUTTERWAVE_SECRET_KEY ?? "",
  interswitchMacKey: process.env.INTERSWITCH_MAC_KEY ?? "",
  interswitchClientId: process.env.INTERSWITCH_CLIENT_ID ?? "",
  interswitchClientSecret: process.env.INTERSWITCH_CLIENT_SECRET ?? "",
  interswitchBaseUrl: process.env.INTERSWITCH_BASE_URL ?? "https://sandbox.interswitchng.com",
  interswitchProductId: process.env.INTERSWITCH_PRODUCT_ID ?? "",

  // Africa's Talking (SMS / USSD)
  atApiKey: process.env.AT_API_KEY ?? process.env.AFRICASTALKING_API_KEY ?? "",
  atUsername: process.env.AT_USERNAME ?? process.env.AFRICASTALKING_USERNAME ?? "",
  atSenderId: process.env.AT_SENDER_ID ?? "NigerianPass",
  /** AT USSD shortcode — e.g. *346# for production, *384*346# for sandbox */
  atUssdShortcode: process.env.AT_USSD_SHORTCODE ?? "*346#",
  /** AT USSD webhook secret for HMAC-SHA256 signature verification */
  atUssdWebhookSecret: process.env.AT_USSD_WEBHOOK_SECRET ?? "",

  // NFC / HSM
  nfcMasterSecret: process.env.NFC_MASTER_SECRET ?? "",
  nfcValidationServiceUrl: process.env.NFC_VALIDATION_SERVICE_URL ?? "http://localhost:9090",
};
