/**
 * NigerianPass Payment Gateway Abstraction
 * =========================================
 * Unified interface for multiple Nigerian payment processors.
 * Supports Paystack, Flutterwave, and Interswitch out of the box.
 * Adding a new provider requires implementing the PaymentProvider interface
 * and registering it in the PROVIDERS map below.
 *
 * Architecture:
 *  ┌─────────────────────────────────────────────────────────┐
 *  │  Client (Wallet page)                                   │
 *  │    → POST /api/trpc/wallet.initiateTopUp                │
 *  │        { amountKobo, provider: "paystack"|"flutterwave" }│
 *  │    ← { checkoutUrl, reference }                         │
 *  │                                                         │
 *  │  Provider Webhook                                       │
 *  │    → POST /api/payments/webhook/:provider               │
 *  │        (HMAC-verified, idempotent)                      │
 *  │    ← 200 OK                                             │
 *  │                                                         │
 *  │  Gateway                                                │
 *  │    → creditWallet(userId, amountKobo, ref)              │
 *  │    → recordTransaction(walletId, ...)                   │
 *  └─────────────────────────────────────────────────────────┘
 */

import crypto from "crypto";
import { ENV } from "../_core/env.js";

// ── Core Types ────────────────────────────────────────────────────────────────

export type PaymentProviderSlug = "paystack" | "flutterwave" | "interswitch";

export interface InitiateTopUpParams {
  /** Unique reference for this transaction */
  reference: string;
  /** Amount in kobo (₦1 = 100 kobo) */
  amountKobo: number;
  /** Customer email address */
  email: string;
  /** Callback URL after payment */
  callbackUrl: string;
  /** Metadata to attach to the transaction */
  metadata?: Record<string, unknown>;
}

export interface InitiateTopUpResult {
  /** URL to redirect the user to for payment */
  checkoutUrl: string;
  /** Provider-assigned transaction reference */
  providerReference: string;
  /** Our internal reference */
  reference: string;
}

export interface WebhookEvent {
  /** Whether the HMAC signature is valid */
  verified: boolean;
  /** Whether this is a successful charge event */
  isChargeSuccess: boolean;
  /** Amount in kobo */
  amountKobo: number;
  /** Our internal reference */
  reference: string;
  /** Provider-assigned reference */
  providerReference: string;
  /** Customer email */
  email: string;
  /** Raw event type string from provider */
  eventType: string;
  /** Full raw payload for logging */
  rawPayload: Record<string, unknown>;
}

export interface VerifyTransactionResult {
  success: boolean;
  amountKobo: number;
  reference: string;
  providerReference: string;
  email: string;
  status: "success" | "failed" | "pending" | "abandoned";
}

/**
 * Interface that every payment provider adapter must implement.
 * To add a new provider (e.g., Monnify, Squad, Kuda):
 *  1. Create a new file in server/payments/providers/<name>.ts
 *  2. Implement this interface
 *  3. Register it in the PROVIDERS map below
 */
export interface PaymentProvider {
  readonly slug: PaymentProviderSlug;
  readonly displayName: string;
  readonly logoUrl: string;
  readonly supportedCurrencies: string[];
  readonly minAmountKobo: number;
  readonly maxAmountKobo: number;

  /**
   * Initiate a top-up and return a checkout URL.
   */
  initiateTopUp(params: InitiateTopUpParams): Promise<InitiateTopUpResult>;

  /**
   * Parse and verify an incoming webhook request.
   * @param rawBody - Raw request body as Buffer (required for HMAC)
   * @param headers - Request headers
   * @param secretKey - Provider secret key
   */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secretKey: string
  ): WebhookEvent;

  /**
   * Verify a transaction by reference (for server-side confirmation).
   */
  verifyTransaction(reference: string, secretKey: string): Promise<VerifyTransactionResult>;
}

// ── Paystack Adapter ──────────────────────────────────────────────────────────

class PaystackProvider implements PaymentProvider {
  readonly slug = "paystack" as const;
  readonly displayName = "Paystack";
  readonly logoUrl = "https://cdn.manus.im/nigerianpass/paystack-logo.png";
  readonly supportedCurrencies = ["NGN"];
  readonly minAmountKobo = 10000;    // ₦100
  readonly maxAmountKobo = 100000000; // ₦1,000,000

  async initiateTopUp(params: InitiateTopUpParams): Promise<InitiateTopUpResult> {
    const secretKey = ENV.paystackSecretKey || "sk_test_demo_key";
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reference: params.reference,
        amount: params.amountKobo,
        email: params.email,
        callback_url: params.callbackUrl,
        metadata: params.metadata ?? {},
        currency: "NGN",
        channels: ["card", "bank", "ussd", "bank_transfer"],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Paystack init failed: ${err}`);
    }

    const data = await response.json() as {
      status: boolean;
      data: { authorization_url: string; reference: string };
    };

    if (!data.status) throw new Error("Paystack returned status=false");

    return {
      checkoutUrl: data.data.authorization_url,
      providerReference: data.data.reference,
      reference: params.reference,
    };
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secretKey: string
  ): WebhookEvent {
    // Verify HMAC-SHA512 signature
    const signature = Array.isArray(headers["x-paystack-signature"])
      ? headers["x-paystack-signature"][0]
      : headers["x-paystack-signature"];

    const expected = crypto
      .createHmac("sha512", secretKey)
      .update(rawBody)
      .digest("hex");

    const verified = !!signature && crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex")
    );

    const payload = JSON.parse(rawBody.toString()) as Record<string, unknown>;
    const eventType = payload.event as string ?? "";
    const eventData = payload.data as Record<string, unknown> ?? {};

    const isChargeSuccess = eventType === "charge.success";
    const amountKobo = typeof eventData.amount === "number" ? eventData.amount : 0;
    const reference = typeof eventData.reference === "string" ? eventData.reference : "";
    const email = typeof (eventData.customer as Record<string, unknown>)?.email === "string"
      ? (eventData.customer as Record<string, unknown>).email as string
      : "";

    return {
      verified,
      isChargeSuccess,
      amountKobo,
      reference,
      providerReference: reference,
      email,
      eventType,
      rawPayload: payload,
    };
  }

  async verifyTransaction(reference: string, secretKey: string): Promise<VerifyTransactionResult> {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });

    if (!response.ok) throw new Error(`Paystack verify failed: ${response.status}`);

    const data = await response.json() as {
      status: boolean;
      data: {
        status: string;
        amount: number;
        reference: string;
        id: number;
        customer: { email: string };
      };
    };

    const d = data.data;
    return {
      success: d.status === "success",
      amountKobo: d.amount,
      reference: d.reference,
      providerReference: String(d.id),
      email: d.customer.email,
      status: d.status as VerifyTransactionResult["status"],
    };
  }
}

// ── Flutterwave Adapter ───────────────────────────────────────────────────────

export class FlutterwaveProvider implements PaymentProvider {
  readonly slug = "flutterwave" as const;
  readonly displayName = "Flutterwave";
  readonly logoUrl = "https://cdn.manus.im/nigerianpass/flutterwave-logo.png";
  readonly supportedCurrencies = ["NGN", "GHS", "KES", "ZAR", "USD"];
  readonly minAmountKobo = 10000;    // ₦100
  readonly maxAmountKobo = 500000000; // ₦5,000,000

  async initiateTopUp(params: InitiateTopUpParams): Promise<InitiateTopUpResult> {
    const secretKey = ENV.flutterwaveSecretKey || "FLWSECK_TEST-demo_key";
    const response = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tx_ref: params.reference,
        amount: params.amountKobo / 100, // Flutterwave uses naira, not kobo
        currency: "NGN",
        redirect_url: params.callbackUrl,
        customer: { email: params.email },
        meta: params.metadata ?? {},
        payment_options: "card,banktransfer,ussd",
        customizations: {
          title: "NigerianPass Wallet Top-up",
          description: "Fund your NigerianPass toll wallet",
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Flutterwave init failed: ${err}`);
    }

    const data = await response.json() as {
      status: string;
      data: { link: string };
    };

    if (data.status !== "success") throw new Error("Flutterwave returned non-success status");

    return {
      checkoutUrl: data.data.link,
      providerReference: params.reference,
      reference: params.reference,
    };
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secretKey: string
  ): WebhookEvent {
    // Flutterwave uses a hash of the payload + secret key
    const signature = Array.isArray(headers["verif-hash"])
      ? headers["verif-hash"][0]
      : headers["verif-hash"];

    // Flutterwave uses a static secret hash (set in dashboard), not HMAC
    const verified = !!signature && signature === secretKey;

    const payload = JSON.parse(rawBody.toString()) as Record<string, unknown>;
    const eventType = payload.event as string ?? "";
    const eventData = payload.data as Record<string, unknown> ?? {};

    const isChargeSuccess = eventType === "charge.completed" &&
      (eventData.status as string) === "successful";

    // Flutterwave returns amount in naira — convert to kobo
    const amountNaira = typeof eventData.amount === "number" ? eventData.amount : 0;
    const amountKobo = Math.round(amountNaira * 100);
    const reference = typeof eventData.tx_ref === "string" ? eventData.tx_ref : "";
    const providerReference = typeof eventData.flw_ref === "string" ? eventData.flw_ref : reference;
    const customerData = eventData.customer as Record<string, unknown> ?? {};
    const email = typeof customerData.email === "string" ? customerData.email : "";

    return {
      verified,
      isChargeSuccess,
      amountKobo,
      reference,
      providerReference,
      email,
      eventType,
      rawPayload: payload,
    };
  }

  async verifyTransaction(reference: string, secretKey: string): Promise<VerifyTransactionResult> {
    const response = await fetch(
      `https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } }
    );

    if (!response.ok) throw new Error(`Flutterwave verify failed: ${response.status}`);

    const data = await response.json() as {
      status: string;
      data: {
        status: string;
        amount: number;
        tx_ref: string;
        flw_ref: string;
        customer: { email: string };
      };
    };

    const d = data.data;
    const success = d.status === "successful";
    return {
      success,
      amountKobo: Math.round(d.amount * 100),
      reference: d.tx_ref,
      providerReference: d.flw_ref,
      email: d.customer.email,
      status: success ? "success" : d.status === "pending" ? "pending" : "failed",
    };
  }
}

// ── Interswitch Adapter ───────────────────────────────────────────────────────

class InterswitchProvider implements PaymentProvider {
  readonly slug = "interswitch" as const;
  readonly displayName = "Interswitch Quickteller";
  readonly logoUrl = "https://cdn.manus.im/nigerianpass/interswitch-logo.png";
  readonly supportedCurrencies = ["NGN"];
  readonly minAmountKobo = 10000;    // ₦100
  readonly maxAmountKobo = 200000000; // ₦2,000,000

  async initiateTopUp(params: InitiateTopUpParams): Promise<InitiateTopUpResult> {
    // Interswitch Quickteller Web SDK checkout
    const clientId = ENV.interswitchClientId || "IKIA_demo";
    const baseUrl = ENV.interswitchBaseUrl || "https://sandbox.interswitchng.com";

    const response = await fetch(`${baseUrl}/api/v2/quickteller/payments/initiate`, {
      method: "POST",
      headers: {
        Authorization: `InterswitchAuth ${Buffer.from(`${clientId}:`).toString("base64")}`,
        "Content-Type": "application/json",
        Timestamp: String(Math.floor(Date.now() / 1000)),
        Nonce: params.reference,
        "Signature-Method": "SHA512",
        Signature: crypto
          .createHmac("sha512", ENV.interswitchClientSecret || "demo_secret")
          .update(`${clientId}${Math.floor(Date.now() / 1000)}${params.reference}`)
          .digest("base64"),
      },
      body: JSON.stringify({
        merchantCode: process.env.INTERSWITCH_MERCHANT_CODE || ENV.interswitchProductId || "MX6072",
        payableCode: process.env.INTERSWITCH_PAYABLE_CODE || "9405967",
        amount: params.amountKobo,
        transactionReference: params.reference,
        currencyCode: "566", // NGN ISO 4217
        customerEmail: params.email,
        redirectUrl: params.callbackUrl,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Interswitch init failed: ${err}`);
    }

    const data = await response.json() as {
      paymentUrl?: string;
      transactionRef?: string;
    };

    const checkoutUrl = data.paymentUrl
      ?? `${baseUrl}/quickteller/pay?transactionRef=${params.reference}`;

    return {
      checkoutUrl,
      providerReference: data.transactionRef ?? params.reference,
      reference: params.reference,
    };
  }

  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
    secretKey: string
  ): WebhookEvent {
    // Interswitch uses HMAC-SHA512 with the client secret
    const signature = Array.isArray(headers["x-interswitch-signature"])
      ? headers["x-interswitch-signature"][0]
      : headers["x-interswitch-signature"];

    const expected = crypto
      .createHmac("sha512", secretKey)
      .update(rawBody)
      .digest("hex");

    const verified = !!signature && crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );

    const payload = JSON.parse(rawBody.toString()) as Record<string, unknown>;
    const responseCode = payload.ResponseCode as string ?? "";
    const isChargeSuccess = responseCode === "00"; // Interswitch success code

    // Interswitch returns amount in kobo
    const amountKobo = typeof payload.Amount === "number" ? payload.Amount : 0;
    const reference = typeof payload.MerchantReference === "string" ? payload.MerchantReference : "";
    const providerReference = typeof payload.TransactionReference === "string"
      ? payload.TransactionReference
      : reference;
    const email = typeof payload.CustomerEmail === "string" ? payload.CustomerEmail : "";

    return {
      verified,
      isChargeSuccess,
      amountKobo,
      reference,
      providerReference,
      email,
      eventType: `interswitch.${responseCode === "00" ? "charge.success" : "charge.failed"}`,
      rawPayload: payload,
    };
  }

  async verifyTransaction(reference: string, secretKey: string): Promise<VerifyTransactionResult> {
    const baseUrl = process.env.INTERSWITCH_BASE_URL ?? "https://sandbox.interswitchng.com";
    const clientId = process.env.INTERSWITCH_CLIENT_ID ?? "IKIA_demo";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(16).toString("hex");

    const response = await fetch(
      `${baseUrl}/api/v2/quickteller/payments/query?transactionRef=${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `InterswitchAuth ${Buffer.from(`${clientId}:`).toString("base64")}`,
          Timestamp: timestamp,
          Nonce: nonce,
          "Signature-Method": "SHA512",
          Signature: crypto
            .createHmac("sha512", secretKey)
            .update(`${clientId}${timestamp}${nonce}`)
            .digest("base64"),
        },
      }
    );

    if (!response.ok) throw new Error(`Interswitch verify failed: ${response.status}`);

    const data = await response.json() as {
      ResponseCode: string;
      Amount: number;
      MerchantReference: string;
      TransactionReference: string;
      CustomerEmail: string;
    };

    const success = data.ResponseCode === "00";
    return {
      success,
      amountKobo: data.Amount,
      reference: data.MerchantReference,
      providerReference: data.TransactionReference,
      email: data.CustomerEmail,
      status: success ? "success" : "failed",
    };
  }
}

// ── Provider Registry ─────────────────────────────────────────────────────────

const PROVIDERS: Record<PaymentProviderSlug, PaymentProvider> = {
  paystack: new PaystackProvider(),
  flutterwave: new FlutterwaveProvider(),
  interswitch: new InterswitchProvider(),
};

/**
 * Get a provider by slug. Throws if the slug is not registered.
 */
export function getProvider(slug: PaymentProviderSlug): PaymentProvider {
  const provider = PROVIDERS[slug];
  if (!provider) {
    throw new Error(`Unknown payment provider: ${slug}. Registered: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return provider;
}

/**
 * List all registered providers with their metadata (for the UI selector).
 */
export function listProviders(): Array<{
  slug: PaymentProviderSlug;
  displayName: string;
  logoUrl: string;
  supportedCurrencies: string[];
  minAmountKobo: number;
  maxAmountKobo: number;
}> {
  return Object.values(PROVIDERS).map(p => ({
    slug: p.slug,
    displayName: p.displayName,
    logoUrl: p.logoUrl,
    supportedCurrencies: p.supportedCurrencies,
    minAmountKobo: p.minAmountKobo,
    maxAmountKobo: p.maxAmountKobo,
  }));
}

/**
 * Get the secret key for a provider from environment variables.
 */
export function getProviderSecretKey(slug: PaymentProviderSlug): string {
  const keyMap: Record<PaymentProviderSlug, string> = {
    paystack: ENV.paystackSecretKey || "sk_test_demo_nigerianpass",
    flutterwave: ENV.flutterwaveSecretKey || "FLWSECK_TEST-demo_nigerianpass",
    interswitch: ENV.interswitchClientSecret || "demo_interswitch_secret",
  };
  return keyMap[slug];
}
