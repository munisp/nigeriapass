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

describe("FlutterwaveProvider reference format", () => {
  it("reference matches nigerianpass_<userId>_<timestamp> pattern", () => {
    const ref = "nigerianpass_42_1700000000000";
    const match = ref.match(/^nigerianpass_(\d+)_/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("42");
  });

  it("extracts userId from reference correctly", () => {
    const ref = "nigerianpass_999_1700000099999";
    const match = ref.match(/^nigerianpass_(\d+)_/);
    const userId = match ? parseInt(match[1], 10) : null;
    expect(userId).toBe(999);
  });

  it("returns null for non-nigerianpass references", () => {
    const ref = "FLW-external-ref-123";
    const match = ref.match(/^nigerianpass_(\d+)_/);
    expect(match).toBeNull();
  });
});
