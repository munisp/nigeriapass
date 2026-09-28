/**
 * RBAC gating tests (audit v13, P0-6)
 *
 * Mutation procedures on devices/nfc routers must reject plain users and
 * unauthenticated callers — adminOnly() inside the resolver was replaced by
 * role-gated procedures (adminProcedure / operatorProcedure).
 */
import { describe, it, expect, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import type { User } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";
import { devicesRouter } from "./routers/devices";
import { nfcRouter } from "./routers/nfc";

function makeUser(role: User["role"]): User {
  return {
    id: 1,
    openId: "test-user",
    name: "Test",
    email: "t@example.com",
    loginMethod: "test",
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
}

function ctxWith(user: User | null): TrpcContext {
  return { req: {} as TrpcContext["req"], res: {} as TrpcContext["res"], user };
}

async function expectTrpcCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error("expected TRPCError but call succeeded");
  } catch (err) {
    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe(code);
  }
}

describe("devices router RBAC (P0-6)", () => {
  const deviceInput = {
    serial: "SN-TEST-1",
    name: "Test Device",
    type: "qr_scanner" as const,
    plaza: "Lekki",
    lane: "Lane 1",
  };

  it("rejects plain users from admin mutations", async () => {
    const caller = devicesRouter.createCaller(ctxWith(makeUser("user")));
    await expectTrpcCode(caller.create(deviceInput), "FORBIDDEN");
    await expectTrpcCode(caller.update({ id: 1, ...deviceInput }), "FORBIDDEN");
    await expectTrpcCode(caller.delete({ id: 1 }), "FORBIDDEN");
    await expectTrpcCode(caller.resolveAlert({ deviceId: 1 }), "FORBIDDEN");
  });

  it("rejects plain users from operator mutations", async () => {
    const caller = devicesRouter.createCaller(ctxWith(makeUser("user")));
    await expectTrpcCode(
      caller.updateHeartbeat({ serial: "SN-TEST-1", cpu: 10, memory: 20, temp: 30, uptime: "1d 0h" }),
      "FORBIDDEN",
    );
  });

  it("rejects unauthenticated callers outright", async () => {
    const caller = devicesRouter.createCaller(ctxWith(null));
    await expectTrpcCode(caller.create(deviceInput), "UNAUTHORIZED");
  });

  it("rejects non-admin roles not in the operator set (e.g. reviewer)", async () => {
    const caller = devicesRouter.createCaller(ctxWith(makeUser("reviewer")));
    await expectTrpcCode(caller.create(deviceInput), "FORBIDDEN");
  });
});

describe("nfc router RBAC (P0-6)", () => {
  const input = { tagId: "TAG123456", vehicleRef: "VEH-LAG-001" };

  it("rejects plain users from provision", async () => {
    const caller = nfcRouter.createCaller(ctxWith(makeUser("user")));
    await expectTrpcCode(caller.provision(input), "FORBIDDEN");
  });

  it("rejects unauthenticated callers from provision", async () => {
    const caller = nfcRouter.createCaller(ctxWith(null));
    await expectTrpcCode(caller.provision(input), "UNAUTHORIZED");
  });

  it("operators/admins pass the RBAC gate (fail later only on missing NFC_MASTER_SECRET)", async () => {
    const caller = nfcRouter.createCaller(ctxWith(makeUser("operator")));
    try {
      await caller.provision(input);
    } catch (err) {
      // In the test env NFC_MASTER_SECRET is unset → PRECONDITION_FAILED is
      // the correct fail-closed behaviour; RBAC has already passed.
      expect(err).toBeInstanceOf(TRPCError);
      expect((err as TRPCError).code).toBe("PRECONDITION_FAILED");
      return;
    }
    throw new Error("expected provisioning to fail without NFC_MASTER_SECRET");
  });
});
