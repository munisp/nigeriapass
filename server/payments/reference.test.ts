/**
 * Unified payment reference helper tests (audit v13, P0-4)
 */
import { describe, it, expect } from "vitest";
import {
  buildPaymentReference,
  parsePaymentReference,
  userIdFromReference,
  providerFromReference,
} from "./reference";

describe("buildPaymentReference", () => {
  it("builds canonical NP-<PROVIDER>-<userId>-<ts>-<rand> references", () => {
    const ref = buildPaymentReference("paystack", 42, 1700000000000);
    expect(ref).toMatch(/^NP-PAYSTACK-42-1700000000000-[A-Z0-9]+$/);
  });

  it("round-trips through parsePaymentReference", () => {
    for (const provider of ["paystack", "flutterwave", "interswitch"] as const) {
      const ref = buildPaymentReference(provider, 7);
      const parsed = parsePaymentReference(ref);
      expect(parsed).not.toBeNull();
      expect(parsed!.provider).toBe(provider);
      expect(parsed!.userId).toBe(7);
      expect(parsed!.legacy).toBe(false);
    }
  });

  it("rejects invalid userIds", () => {
    expect(() => buildPaymentReference("paystack", 0)).toThrow();
    expect(() => buildPaymentReference("paystack", -1)).toThrow();
    expect(() => buildPaymentReference("paystack", 1.5)).toThrow();
  });
});

describe("parsePaymentReference", () => {
  it("parses canonical references with and without the random suffix", () => {
    expect(parsePaymentReference("NP-PAYSTACK-1-1700000000000")?.userId).toBe(1);
    expect(parsePaymentReference("NP-INTERSWITCH-99-1700000000123-XYZ123")).toMatchObject({
      provider: "interswitch",
      userId: 99,
      timestamp: 1700000000123,
      legacy: false,
    });
  });

  it("parses legacy NP-TOPUP-<userId>-<ts> (read-only compatibility)", () => {
    const parsed = parsePaymentReference("NP-TOPUP-42-1700000000000");
    expect(parsed).toMatchObject({ userId: 42, timestamp: 1700000000000, legacy: true });
  });

  it("parses legacy nigerianpass_<userId>_<ts> (read-only compatibility)", () => {
    const parsed = parsePaymentReference("nigerianpass_42_1700000000000");
    expect(parsed).toMatchObject({ userId: 42, timestamp: 1700000000000, legacy: true });
  });

  it("rejects garbage and non-NigerianPass references", () => {
    expect(parsePaymentReference("")).toBeNull();
    expect(parsePaymentReference("FLW-external-123")).toBeNull();
    expect(parsePaymentReference("NP-UNKNOWN-1-1700000000000")).toBeNull();
    expect(parsePaymentReference("NP-PAYSTACK-abc-1700000000000")).toBeNull();
    expect(parsePaymentReference("NP-PAYSTACK-1-123")).toBeNull(); // too short to be a ms timestamp
  });
});

describe("convenience accessors", () => {
  it("userIdFromReference / providerFromReference", () => {
    const ref = buildPaymentReference("flutterwave", 555);
    expect(userIdFromReference(ref)).toBe(555);
    expect(providerFromReference(ref)).toBe("flutterwave");
    expect(userIdFromReference("garbage")).toBeNull();
    expect(providerFromReference("garbage")).toBeNull();
  });
});
