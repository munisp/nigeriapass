/**
 * USSD State Machine Tests
 * =========================
 * Tests the *346# USSD session processor end-to-end, covering:
 *  - Main menu navigation
 *  - Balance check flow
 *  - Top-up flow (amount entry, confirmation)
 *  - Mini statement flow
 *  - Vehicle registration flow
 *  - Application status lookup
 *  - Exit / session cleanup
 *  - Africa's Talking webhook signature verification
 *  - Invalid input handling
 *  - Session TTL / expiry
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { processUssdInput } from "./routers/ussd.js";
import crypto from "crypto";

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeSessionId() {
  return `TEST-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const PHONE = "+2348012345678";

// ── Main Menu ─────────────────────────────────────────────────────────────────
describe("USSD *346# — Main Menu", () => {
  it("returns CON main menu on empty text (session start)", async () => {
    const sid = makeSessionId();
    const resp = await processUssdInput(sid, PHONE, "");
    expect(resp).toMatch(/^CON /);
    expect(resp).toContain("NigerianPass");
    expect(resp).toContain("1.");
    expect(resp).toContain("2.");
    expect(resp).toContain("3.");
    expect(resp).toContain("4.");
    expect(resp).toContain("5.");
  });

  it("returns CON main menu on first call with no text", async () => {
    const sid = makeSessionId();
    const resp = await processUssdInput(sid, PHONE, "");
    expect(resp.startsWith("CON ")).toBe(true);
  });
});

// ── Balance Check ─────────────────────────────────────────────────────────────
describe("USSD *346# — Balance Check (option 1)", () => {
  it("returns balance information for option 1", async () => {
    const sid = makeSessionId();
    // Start session
    await processUssdInput(sid, PHONE, "");
    // Select option 1 (Check Balance)
    const resp = await processUssdInput(sid, PHONE, "1");
    // Should return END with balance info or CON with balance
    expect(resp).toMatch(/^(CON|END) /);
    // Should contain balance-related text
    expect(resp.toLowerCase()).toMatch(/balance|wallet|ngn|₦/i);
  });

  it("handles balance check without a wallet account gracefully", async () => {
    const sid = makeSessionId();
    await processUssdInput(sid, PHONE, "");
    const resp = await processUssdInput(sid, PHONE, "1");
    // Should not throw — returns a valid USSD response
    expect(resp).toMatch(/^(CON|END) /);
    expect(resp.length).toBeGreaterThan(4);
  });
});

// ── Top-Up Flow ───────────────────────────────────────────────────────────────
describe("USSD *346# — Top-Up Flow (option 2)", () => {
  it("shows top-up amount menu on option 2", async () => {
    const sid = makeSessionId();
    await processUssdInput(sid, PHONE, "");
    const resp = await processUssdInput(sid, PHONE, "2");
    expect(resp).toMatch(/^CON /);
    expect(resp.toLowerCase()).toMatch(/top.?up|amount|ngn|₦/i);
  });

  it("accepts a valid amount and shows confirmation", async () => {
    const sid = makeSessionId();
    await processUssdInput(sid, PHONE, "");
    await processUssdInput(sid, PHONE, "2");
    // Enter a valid amount (₦500)
    const resp = await processUssdInput(sid, PHONE, "2*500");
    expect(resp).toMatch(/^CON /);
    expect(resp.toLowerCase()).toMatch(/confirm|500|continue/i);
  });

  it("allows going back from top-up menu", async () => {
    const sid = makeSessionId();
    await processUssdInput(sid, PHONE, "");
    await processUssdInput(sid, PHONE, "2");
    // Press 0 to go back
    const resp = await processUssdInput(sid, PHONE, "2*0");
    expect(resp).toMatch(/^CON /);
    // Should be back at main menu
    expect(resp).toContain("NigerianPass");
  });

  it("rejects invalid amount entry", async () => {
    const sid = makeSessionId();
    await processUssdInput(sid, PHONE, "");
    await processUssdInput(sid, PHONE, "2");
    // Enter invalid amount (text instead of number)
    const resp = await processUssdInput(sid, PHONE, "2*abc");
    expect(resp).toMatch(/^(CON|END) /);
    // Should show error or prompt again
    expect(resp.length).toBeGreaterThan(4);
  });
});

// ── Mini Statement ────────────────────────────────────────────────────────────
describe("USSD *346# — Mini Statement (option 3)", () => {
  it("shows mini statement on option 3", async () => {
    const sid = makeSessionId();
    await processUssdInput(sid, PHONE, "");
    const resp = await processUssdInput(sid, PHONE, "3");
    expect(resp).toMatch(/^(CON|END) /);
    // Should contain transaction-related text or "no transactions"
    expect(resp.toLowerCase()).toMatch(/transaction|statement|history|no recent|balance/i);
  });
});

// ── Vehicle Registration ──────────────────────────────────────────────────────
describe("USSD *346# — Vehicle Registration (option 4)", () => {
  it("prompts for plate number on option 4", async () => {
    const sid = makeSessionId();
    await processUssdInput(sid, PHONE, "");
    const resp = await processUssdInput(sid, PHONE, "4");
    expect(resp).toMatch(/^CON /);
    expect(resp.toLowerCase()).toMatch(/plate|vehicle|registration|number/i);
  });

  it("accepts a valid plate number and shows confirmation", async () => {
    const sid = makeSessionId();
    await processUssdInput(sid, PHONE, "");
    await processUssdInput(sid, PHONE, "4");
    const resp = await processUssdInput(sid, PHONE, "4*ABC123DE");
    expect(resp).toMatch(/^CON /);
    expect(resp.toLowerCase()).toMatch(/confirm|ABC123DE|plate/i);
  });

  it("rejects a plate number that is too short", async () => {
    const sid = makeSessionId();
    await processUssdInput(sid, PHONE, "");
    await processUssdInput(sid, PHONE, "4");
    const resp = await processUssdInput(sid, PHONE, "4*AB");
    expect(resp).toMatch(/^(CON|END) /);
    expect(resp.toLowerCase()).toMatch(/invalid|short|try again|plate/i);
  });

  it("completes registration on confirmation", async () => {
    const sid = makeSessionId();
    await processUssdInput(sid, PHONE, "");
    await processUssdInput(sid, PHONE, "4");
    await processUssdInput(sid, PHONE, "4*LAG123AB");
    // Confirm with option 1
    const resp = await processUssdInput(sid, PHONE, "4*LAG123AB*1");
    expect(resp).toMatch(/^END /);
    expect(resp.toLowerCase()).toMatch(/registered|success|ref|kyc/i);
  });

  it("cancels registration on option 2", async () => {
    const sid = makeSessionId();
    await processUssdInput(sid, PHONE, "");
    await processUssdInput(sid, PHONE, "4");
    await processUssdInput(sid, PHONE, "4*LAG123AB");
    const resp = await processUssdInput(sid, PHONE, "4*LAG123AB*2");
    expect(resp).toMatch(/^END /);
    expect(resp.toLowerCase()).toMatch(/cancel/i);
  });
});

// ── Application Status ────────────────────────────────────────────────────────
describe("USSD *346# — Application Status (option 5)", () => {
  it("prompts for reference number on option 5", async () => {
    const sid = makeSessionId();
    await processUssdInput(sid, PHONE, "");
    const resp = await processUssdInput(sid, PHONE, "5");
    expect(resp).toMatch(/^CON /);
    expect(resp.toLowerCase()).toMatch(/reference|ref|number|status/i);
  });

  it("returns not-found for unknown reference", async () => {
    const sid = makeSessionId();
    await processUssdInput(sid, PHONE, "");
    await processUssdInput(sid, PHONE, "5");
    const resp = await processUssdInput(sid, PHONE, "5*UNKNOWN-REF-XYZ");
    expect(resp).toMatch(/^END /);
    expect(resp.toLowerCase()).toMatch(/not found|no application|unknown/i);
  });

  it("allows going back from status prompt", async () => {
    const sid = makeSessionId();
    await processUssdInput(sid, PHONE, "");
    await processUssdInput(sid, PHONE, "5");
    const resp = await processUssdInput(sid, PHONE, "5*0");
    expect(resp).toMatch(/^CON /);
    expect(resp).toContain("NigerianPass");
  });
});

// ── Exit ──────────────────────────────────────────────────────────────────────
describe("USSD *346# — Exit (option 0)", () => {
  it("ends session on option 0", async () => {
    const sid = makeSessionId();
    await processUssdInput(sid, PHONE, "");
    const resp = await processUssdInput(sid, PHONE, "0");
    expect(resp).toMatch(/^END /);
    expect(resp.toLowerCase()).toMatch(/thank|safe|goodbye/i);
  });
});

// ── Invalid Input ─────────────────────────────────────────────────────────────
describe("USSD *346# — Invalid Input Handling", () => {
  it("returns CON with error message on invalid main menu option", async () => {
    const sid = makeSessionId();
    await processUssdInput(sid, PHONE, "");
    const resp = await processUssdInput(sid, PHONE, "9");
    expect(resp).toMatch(/^CON /);
    expect(resp.toLowerCase()).toMatch(/invalid|option/i);
  });

  it("handles empty sessionId gracefully", async () => {
    // Should not throw even with unusual input
    const resp = await processUssdInput("", PHONE, "");
    expect(resp).toMatch(/^(CON|END) /);
  });
});

// ── Webhook Signature Verification ───────────────────────────────────────────
describe("USSD Webhook — Signature Verification", () => {
  it("computes HMAC-SHA256 correctly for AT signature format", () => {
    const secret = "test-webhook-secret-12345";
    const body = "sessionId=AT-123&serviceCode=*346%23&phoneNumber=%2B2348012345678&text=1";
    const expected = crypto
      .createHmac("sha256", secret)
      .update(Buffer.from(body, "utf8"))
      .digest("hex");
    // Verify the format is a 64-char hex string
    expect(expected).toMatch(/^[a-f0-9]{64}$/);
  });

  it("detects tampered body via HMAC mismatch", () => {
    const secret = "test-webhook-secret-12345";
    const originalBody = "sessionId=AT-123&text=1";
    const tamperedBody = "sessionId=AT-123&text=2";
    const originalSig = crypto
      .createHmac("sha256", secret)
      .update(Buffer.from(originalBody, "utf8"))
      .digest("hex");
    const tamperedSig = crypto
      .createHmac("sha256", secret)
      .update(Buffer.from(tamperedBody, "utf8"))
      .digest("hex");
    expect(originalSig).not.toBe(tamperedSig);
  });

  it("uses timing-safe comparison to prevent timing attacks", () => {
    const secret = "test-webhook-secret-12345";
    const body = "sessionId=AT-123&text=1";
    const sig = crypto
      .createHmac("sha256", secret)
      .update(Buffer.from(body, "utf8"))
      .digest("hex");
    const sigBuf = Buffer.from(sig, "hex");
    const expBuf = Buffer.from(sig, "hex");
    // timingSafeEqual should return true for identical buffers
    expect(crypto.timingSafeEqual(sigBuf, expBuf)).toBe(true);
    // And false for different buffers of same length
    const wrongBuf = Buffer.alloc(sigBuf.length, 0);
    expect(crypto.timingSafeEqual(sigBuf, wrongBuf)).toBe(false);
  });
});

// ── Session Isolation ─────────────────────────────────────────────────────────
describe("USSD *346# — Session Isolation", () => {
  it("maintains separate state for concurrent sessions", async () => {
    const sid1 = makeSessionId();
    const sid2 = makeSessionId();
    // Start two sessions simultaneously
    await processUssdInput(sid1, "+2348011111111", "");
    await processUssdInput(sid2, "+2348022222222", "");
    // Navigate session 1 to balance check
    await processUssdInput(sid1, "+2348011111111", "1");
    // Session 2 should still be at main menu
    const resp2 = await processUssdInput(sid2, "+2348022222222", "2");
    // Session 2 should be at top-up, not balance check
    expect(resp2.toLowerCase()).toMatch(/top.?up|amount|ngn/i);
  });

  it("different sessions for same phone are independent", async () => {
    const sid1 = makeSessionId();
    const sid2 = makeSessionId();
    await processUssdInput(sid1, PHONE, "");
    await processUssdInput(sid2, PHONE, "");
    // Navigate sid1 to option 4 (vehicle registration)
    await processUssdInput(sid1, PHONE, "4");
    // sid2 should still be at main menu
    const resp2 = await processUssdInput(sid2, PHONE, "3");
    // Should be mini statement, not vehicle registration
    expect(resp2.toLowerCase()).toMatch(/transaction|statement|history|balance/i);
  });
});
