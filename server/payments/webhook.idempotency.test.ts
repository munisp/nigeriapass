/**
 * Payment webhook hardening tests (audit v13, P0-3/4/5)
 *
 *  - invalid HMAC is ALWAYS rejected (no demo bypass)
 *  - idempotent double-credit protection: replayed webhooks never re-credit
 *  - legacy POST /api/payments/initiate handlers are gone (404)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";

const creditWalletAtomicMock = vi.fn();
const getDbMock = vi.fn(async () => ({ fake: true }));

vi.mock("../db", () => ({
  getDb: () => getDbMock(),
  creditWalletAtomic: (args: unknown) => creditWalletAtomicMock(args),
}));

vi.mock("../events/kycEvents", () => ({
  getKycStatusEmitter: () => ({ emit: vi.fn() }),
}));

vi.mock("../_core/audit", () => ({
  writeAuditLog: vi.fn(async () => {}),
}));

const SECRET = "FLWSECK-real-test-secret";
vi.mock("./gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway")>();
  return {
    ...actual,
    getProviderSecretKey: () => SECRET,
  };
});

import { paymentsRouter } from "../routes/payments";

function makeApp() {
  const app = express();
  // Mirrors server/_core/index.ts: raw body captured BEFORE global parser
  app.use("/api/payments", express.json({
    verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }));
  app.use("/api/payments", paymentsRouter);
  return app;
}

function chargePayload(reference: string) {
  return {
    event: "charge.completed",
    data: {
      id: 1,
      tx_ref: reference,
      flw_ref: "FLW-1",
      amount: 5000,
      currency: "NGN",
      status: "successful",
      customer: { email: "t@example.com" },
    },
  };
}

describe("payments webhook hardening", () => {
  let server: ReturnType<ReturnType<typeof makeApp>["listen"]>;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = makeApp().listen(0);
    await new Promise<void>((r) => server.on("listening", r));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function postWebhook(body: unknown, headers: Record<string, string> = {}) {
    return fetch(`http://127.0.0.1:${port}/api/payments/webhook/flutterwave`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("rejects invalid HMAC with 401 — there is NO demo bypass (P0-2)", async () => {
    const res = await postWebhook(chargePayload("NP-FLUTTERWAVE-42-1700000000000"), {
      "verif-hash": "forged",
    });
    expect(res.status).toBe(401);
    expect(creditWalletAtomicMock).not.toHaveBeenCalled();
  });

  it("credits once and treats the replay as a duplicate (P0-4 idempotency)", async () => {
    const reference = "NP-FLUTTERWAVE-42-1700000000000-AB12CD";
    creditWalletAtomicMock
      .mockResolvedValueOnce({ status: "credited", walletId: 9, transactionId: 1, newBalanceKobo: 500000 })
      .mockResolvedValueOnce({ status: "duplicate" });

    const first = await postWebhook(chargePayload(reference), { "verif-hash": SECRET });
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.action).toBe("credited");
    expect(firstBody.newBalanceKobo).toBe(500000);

    // Exact replay — the provider retries delivery; wallet must NOT re-credit
    const second = await postWebhook(chargePayload(reference), { "verif-hash": SECRET });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.action).toBe("duplicate");

    expect(creditWalletAtomicMock).toHaveBeenCalledTimes(2);
    expect(creditWalletAtomicMock.mock.calls[0]![0]).toMatchObject({
      userId: 42, // parsed from the unified reference
      amountKobo: 500000,
      externalRef: reference,
    });
  });

  it("unparseable references are recorded for manual reconciliation, never credited", async () => {
    const res = await postWebhook(chargePayload("FLW-external-xyz"), { "verif-hash": SECRET });
    expect(res.status).toBe(200);
    expect((await res.json()).action).toBe("unmatched");
    expect(creditWalletAtomicMock).not.toHaveBeenCalled();
  });

  it("legacy POST /api/payments/initiate handlers are gone (P0-5)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/payments/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "flutterwave", amountKobo: 1000 }),
    });
    expect(res.status).toBe(404);
  });
});
