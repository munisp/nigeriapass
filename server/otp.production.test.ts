/**
 * OTP fail-closed tests (audit v13, P0-1)
 *
 * In production (NODE_ENV=production), the demo code 123456 must NEVER be
 * accepted and sendOtp must throw when no SMS provider is configured.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Force the env module to look like a production deployment with NO SMS key.
// NODE_ENV is also stubbed to "production" for any code that reads it directly;
// both are restored after each test so sibling suites are unaffected.
vi.mock("./_core/env", () => ({
  ENV: {
    isProduction: true,
    atApiKey: "",
    atUsername: "",
    atSenderId: "NigerianPass",
  },
}));

// No DB in tests: getDb() returns null so verifyOtp must hit the production
// fail-closed branch ("OTP store unavailable") instead of attempting a real
// PostgreSQL connection (which would throw a different error or hang).
vi.mock("./db", () => ({
  getDb: vi.fn().mockResolvedValue(null),
}));

import { sendOtp, verifyOtp } from "./services/otp";

describe("OTP in production (fail closed)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AT_API_KEY", "");
    vi.stubEnv("AFRICASTALKING_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sendOtp throws when no SMS provider is configured", async () => {
    await expect(sendOtp("+2348012345678")).rejects.toThrow(/SMS provider not configured/i);
  });

  it("verifyOtp does NOT accept the demo code 123456", async () => {
    // getDb() returns null in the test environment; in production this must
    // fail closed rather than falling back to the fixed demo code.
    await expect(verifyOtp("+2348012345678", "123456")).rejects.toThrow(/OTP store unavailable/i);
  });

  it("sendOtp never leaks a demoCode in production", async () => {
    // Even if sendOtp somehow succeeded, demoCode must be undefined.
    // Here it throws before returning, which is the fail-closed behaviour.
    const result = await sendOtp("+2348098765432").catch(() => null);
    expect(result).toBeNull();
  });
});
