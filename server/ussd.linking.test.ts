/**
 * USSD account-linking tests (audit v13, P0-10)
 *
 * The webhook must resolve the MSISDN to a user (openId "phone:<msisdn>")
 * and pass that userId into the state machine — previously it always passed
 * undefined, so balance/statement flows could never identify the caller.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";

const processUssdInputMock = vi.fn(async () => "END ok");
const getUserByPhoneMock = vi.fn(async (msisdn: string) =>
  msisdn === "+2348012345678" ? { id: 777 } : null,
);

vi.mock("./routers/ussd.js", () => ({
  processUssdInput: (...args: unknown[]) => processUssdInputMock(...args),
}));

vi.mock("./db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db.js")>();
  return {
    ...actual,
    getDb: async () => null, // no DB in tests — analytics persistence no-ops
    getUserByPhone: (msisdn: string) => getUserByPhoneMock(msisdn),
  };
});

import { ussdWebhookRouter } from "./routes/ussd";

function makeApp() {
  const app = express();
  // Do NOT mount express.urlencoded here: ussdWebhookRouter captures the raw
  // body itself for HMAC verification, and a consumed stream would make its
  // raw-body middleware wait forever for an "end" event that already fired
  // (this was the source of the test hangs/timeouts).
  app.use("/api/ussd", ussdWebhookRouter);
  return app;
}

async function postUssd(port: number, body: Record<string, string>) {
  const res = await fetch(`http://127.0.0.1:${port}/api/ussd/session`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return res.text();
}

describe("USSD webhook account linking (P0-10)", () => {
  let server: ReturnType<ReturnType<typeof makeApp>["listen"]>;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = makeApp().listen(0);
    await new Promise<void>((resolve) => server.on("listening", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("links a registered phone to its userId", { timeout: 15000 }, async () => {
    const text = await postUssd(port, {
      sessionId: "sess-linked-1",
      phoneNumber: "+2348012345678",
      text: "",
    });
    expect(text).toBe("END ok");
    expect(getUserByPhoneMock).toHaveBeenCalledWith("+2348012345678");
    const call = processUssdInputMock.mock.calls[0]!;
    expect(call[0]).toBe("sess-linked-1");
    expect(call[1]).toBe("+2348012345678");
    expect(call[2]).toBe("");
    // userId resolved server-side — NOT undefined
    expect(call[3]).toBe("777");
  });

  it("passes undefined userId for unregistered phones (no fabrication)", { timeout: 15000 }, async () => {
    const text = await postUssd(port, {
      sessionId: "sess-unlinked-1",
      phoneNumber: "+2349099999999",
      text: "",
    });
    expect(text).toBe("END ok");
    const call = processUssdInputMock.mock.calls[0]!;
    expect(call[0]).toBe("sess-unlinked-1");
    expect(call[3]).toBeUndefined();
  });
});
