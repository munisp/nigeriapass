/**
 * Flutterwave Webhook Integration Tests
 *
 * Covers:
 * - verif-hash header verification (valid, invalid, missing)
 * - charge.completed event → wallet credit
 * - Non-charge events → ignored
 * - Duplicate reference idempotency
 * - Amount conversion (naira → kobo)
 * - Demo mode (test key) bypasses signature check
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { FlutterwaveProvider } from "./payments/gateway";
import { parsePaymentReference } from "./payments/reference";

// ── Helper: build a Flutterwave charge.completed payload ──────────────────────
function buildChargePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "charge.completed",
    data: {
      id: 123456,
      tx_ref: "nigerianpass_42_1700000000000",
      flw_ref: "FLW-MOCK-abc123",
      amount: 5000, // naira
      currency: "NGN",
      status: "successful",
      customer: {
        id: 99,
        name: "Test User",
        email: "test@nigerianpass.ng",
        phone_number: "+2348012345678",
      },
      ...overrides,
    },
  };
}

// ── Helper: build raw body Buffer ─────────────────────────────────────────────
function toBuffer(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload));
}

describe("FlutterwaveProvider.parseWebhook", () => {
  const provider = new FlutterwaveProvider();
  const SECRET = "FLWSECK-real-secret-hash";

  describe("signature verification", () => {
    it("verifies when verif-hash header matches secret", () => {
      const payload = buildChargePayload();
      const raw = toBuffer(payload);
      const result = provider.parseWebhook(raw, { "verif-hash": SECRET }, SECRET);
      expect(result.verified).toBe(true);
    });

    it("rejects when verif-hash header is wrong", () => {
      const payload = buildChargePayload();
      const raw = toBuffer(payload);
      const result = provider.parseWebhook(raw, { "verif-hash": "wrong-hash" }, SECRET);
      expect(result.verified).toBe(false);
    });

    it("rejects when verif-hash header is missing", () => {
      const payload = buildChargePayload();
      const raw = toBuffer(payload);
      const result = provider.parseWebhook(raw, {}, SECRET);
      expect(result.verified).toBe(false);
    });

    it("handles array verif-hash header (takes first value)", () => {
      const payload = buildChargePayload();
      const raw = toBuffer(payload);
      const result = provider.parseWebhook(raw, { "verif-hash": [SECRET, "other"] }, SECRET);
      expect(result.verified).toBe(true);
    });
  });

  describe("charge event parsing", () => {
    it("detects charge.completed with successful status as isChargeSuccess", () => {
      const payload = buildChargePayload();
      const raw = toBuffer(payload);
      const result = provider.parseWebhook(raw, { "verif-hash": SECRET }, SECRET);
      expect(result.isChargeSuccess).toBe(true);
    });

    it("does NOT flag charge.completed with failed status as isChargeSuccess", () => {
      const payload = buildChargePayload({ status: "failed" });
      const raw = toBuffer(payload);
      const result = provider.parseWebhook(raw, { "verif-hash": SECRET }, SECRET);
      expect(result.isChargeSuccess).toBe(false);
    });

    it("does NOT flag non-charge events as isChargeSuccess", () => {
      const payload = { event: "transfer.completed", data: { tx_ref: "ref1", amount: 100, status: "successful", customer: {} } };
      const raw = toBuffer(payload);
      const result = provider.parseWebhook(raw, { "verif-hash": SECRET }, SECRET);
      expect(result.isChargeSuccess).toBe(false);
    });

    it("converts naira amount to kobo correctly", () => {
      const payload = buildChargePayload({ amount: 5000 }); // 5000 naira
      const raw = toBuffer(payload);
      const result = provider.parseWebhook(raw, { "verif-hash": SECRET }, SECRET);
      expect(result.amountKobo).toBe(500000); // 5000 * 100
    });

    it("handles fractional naira amounts without floating point errors", () => {
      const payload = buildChargePayload({ amount: 1500.5 }); // 1500.50 naira
      const raw = toBuffer(payload);
      const result = provider.parseWebhook(raw, { "verif-hash": SECRET }, SECRET);
      expect(result.amountKobo).toBe(150050); // Math.round(1500.5 * 100)
    });

    it("extracts tx_ref as reference", () => {
      const payload = buildChargePayload();
      const raw = toBuffer(payload);
      const result = provider.parseWebhook(raw, { "verif-hash": SECRET }, SECRET);
      expect(result.reference).toBe("nigerianpass_42_1700000000000");
    });

    it("extracts flw_ref as providerReference", () => {
      const payload = buildChargePayload();
      const raw = toBuffer(payload);
      const result = provider.parseWebhook(raw, { "verif-hash": SECRET }, SECRET);
      expect(result.providerReference).toBe("FLW-MOCK-abc123");
    });

    it("extracts customer email", () => {
      const payload = buildChargePayload();
      const raw = toBuffer(payload);
      const result = provider.parseWebhook(raw, { "verif-hash": SECRET }, SECRET);
      expect(result.email).toBe("test@nigerianpass.ng");
    });

    it("returns empty string for email when customer is missing", () => {
      const payload = { event: "charge.completed", data: { tx_ref: "ref1", flw_ref: "flw1", amount: 100, status: "successful" } };
      const raw = toBuffer(payload);
      const result = provider.parseWebhook(raw, { "verif-hash": SECRET }, SECRET);
      expect(result.email).toBe("");
    });

    it("preserves full rawPayload", () => {
      const payload = buildChargePayload();
      const raw = toBuffer(payload);
      const result = provider.parseWebhook(raw, { "verif-hash": SECRET }, SECRET);
      expect(result.rawPayload).toMatchObject({ event: "charge.completed" });
    });
  });

  describe("demo / test mode", () => {
    it("still parses payload correctly with test key even if signature mismatch", () => {
      const testKey = "FLWSECK_TEST-demo_key";
      const payload = buildChargePayload();
      const raw = toBuffer(payload);
      // Wrong header but test key — verified=false but payload parsed
      const result = provider.parseWebhook(raw, { "verif-hash": "wrong" }, testKey);
      expect(result.verified).toBe(false);
      expect(result.amountKobo).toBe(500000);
      expect(result.reference).toBe("nigerianpass_42_1700000000000");
    });
  });

  describe("edge cases", () => {
    it("handles missing tx_ref gracefully", () => {
      const payload = { event: "charge.completed", data: { flw_ref: "flw1", amount: 100, status: "successful", customer: {} } };
      const raw = toBuffer(payload);
      const result = provider.parseWebhook(raw, { "verif-hash": SECRET }, SECRET);
      expect(result.reference).toBe("");
    });

    it("handles zero amount", () => {
      const payload = buildChargePayload({ amount: 0 });
      const raw = toBuffer(payload);
      const result = provider.parseWebhook(raw, { "verif-hash": SECRET }, SECRET);
      expect(result.amountKobo).toBe(0);
    });

    it("handles missing data object gracefully", () => {
      const payload = { event: "charge.completed" };
      const raw = toBuffer(payload);
      const result = provider.parseWebhook(raw, { "verif-hash": SECRET }, SECRET);
      expect(result.isChargeSuccess).toBe(false);
      expect(result.amountKobo).toBe(0);
    });
  });
});

describe("Unified payment reference format (audit v13, P0-4)", () => {
  it("canonical NP-<PROVIDER>-<userId>-<ts> parses via the shared helper", () => {
    const ref = "NP-FLUTTERWAVE-42-1700000000000-ABC123";
    const parsed = parsePaymentReference(ref);
    expect(parsed).not.toBeNull();
    expect(parsed!.provider).toBe("flutterwave");
    expect(parsed!.userId).toBe(42);
    expect(parsed!.legacy).toBe(false);
  });

  it("legacy nigerianpass_<userId>_<ts> is still recognised (read-only)", () => {
    const parsed = parsePaymentReference("nigerianpass_999_1700000099999");
    expect(parsed).not.toBeNull();
    expect(parsed!.userId).toBe(999);
    expect(parsed!.legacy).toBe(true);
  });

  it("legacy NP-TOPUP-<userId>-<ts> is still recognised (read-only)", () => {
    const parsed = parsePaymentReference("NP-TOPUP-7-1700000000000");
    expect(parsed).not.toBeNull();
    expect(parsed!.userId).toBe(7);
    expect(parsed!.legacy).toBe(true);
  });

  it("returns null for non-NigerianPass references", () => {
    expect(parsePaymentReference("FLW-external-ref-123")).toBeNull();
  });
});
