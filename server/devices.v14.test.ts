/**
 * Device v14 Feature Tests
 * ========================
 * Verifies:
 *  - devices.broadcastFirmwareUpdate — admin-only, NOT_FOUND for plaza, batch WS events,
 *    returns per-device results, respects targetVersion
 *  - ussd.getSessionStats — protected, returns correct aggregates, handles empty DB
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Shared mock DB state ───────────────────────────────────────────────────────

type MockDevice = {
  id: number; serial: string; name: string; type: string;
  plaza: string; lane: string; status: string; firmware: string;
  latestFirmware: string; uptime: string; cpu: number; memory: number;
  temp: number; alerts: number; lastSeen: Date; createdAt: Date; updatedAt: Date;
};

let mockDevices: MockDevice[] = [];

function resetDb() {
  mockDevices = [];
}

function seedDevice(overrides: Partial<MockDevice> = {}): MockDevice {
  const id = mockDevices.length + 1;
  const now = new Date();
  const d: MockDevice = {
    id,
    serial: `NFC-LOS-00${id}`,
    name: `NFC Reader — Lane ${id}`,
    type: "nfc_reader",
    plaza: "Lagos-Ibadan Toll",
    lane: `Lane ${id}`,
    status: "online",
    firmware: "2.4.1",
    latestFirmware: "2.4.2",
    uptime: "5d 3h",
    cpu: 20,
    memory: 40,
    temp: 38,
    alerts: 0,
    lastSeen: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  mockDevices.push(d);
  return d;
}

// ── Mock the DB module ─────────────────────────────────────────────────────────

const mockSelect = vi.fn();
const mockUpdate = vi.fn();
const mockInsert = vi.fn();

vi.mock("../server/db", () => ({
  getDb: vi.fn().mockImplementation(() =>
    Promise.resolve({ select: mockSelect, update: mockUpdate, insert: mockInsert })
  ),
}));

// ── Mock deviceHeartbeat module ────────────────────────────────────────────────

const mockEmitDeviceHeartbeat = vi.fn();

vi.mock("../server/deviceHeartbeat", () => ({
  emitDeviceHeartbeat: mockEmitDeviceHeartbeat,
}));

// ── Mock notification module ───────────────────────────────────────────────────

const mockNotifyOwner = vi.fn().mockResolvedValue(true);

vi.mock("../server/_core/notification", () => ({
  notifyOwner: mockNotifyOwner,
}));

// ── Helper to build a mock tRPC context ───────────────────────────────────────

function makeCtx(role: "admin" | "user" = "admin") {
  return {
    user: { id: 1, openId: "test-open-id", name: "Admin User", role },
    req: {} as never,
    res: {} as never,
  };
}

// ── broadcastFirmwareUpdate tests ─────────────────────────────────────────────

describe("devices.broadcastFirmwareUpdate", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
  });

   it("broadcasts firmware update events to all devices at the specified plaza", async () => {
    const d1 = seedDevice({ plaza: "Lagos-Ibadan Toll", serial: "NFC-LOS-001", firmware: "2.4.1", latestFirmware: "2.4.2" });
    const d2 = seedDevice({ plaza: "Lagos-Ibadan Toll", serial: "NFC-LOS-002", firmware: "2.4.1", latestFirmware: "2.4.2" });
    mockSelect.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([d1, d2]),
      }),
    });
    mockUpdate.mockReturnValue({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    });
    const { devicesRouter } = await import("../server/routers/devices");;
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.broadcastFirmwareUpdate({
      plaza: "Lagos-Ibadan Toll",
      targetVersion: "2.4.2",
    });

    expect(result.plaza).toBe("Lagos-Ibadan Toll");
    // The procedure returns sent/skipped/failed counts, not a top-level targetVersion
    expect(result.total).toBe(2);
    expect(result.results).toHaveLength(2);
    // Both devices should be sent (firmware 2.4.1 !== targetVersion 2.4.2)
    expect(result.sent).toBe(2);
    expect(result.results.every(r => r.status === "sent")).toBe(true);
    // emitDeviceHeartbeat should have been called once per device
    expect(mockEmitDeviceHeartbeat).toHaveBeenCalledTimes(2);
  });

  it("throws NOT_FOUND when no devices are found at the plaza", async () => {
    mockSelect.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    await expect(
      caller.broadcastFirmwareUpdate({ plaza: "Nonexistent Plaza", targetVersion: "2.4.2" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mockEmitDeviceHeartbeat).not.toHaveBeenCalled();
  });

  it("uses device latestFirmware when targetVersion is not specified", async () => {
    const d1 = seedDevice({ plaza: "Lagos-Ibadan Toll", firmware: "2.4.1", latestFirmware: "2.5.0" });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([d1]),
      }),
    });
    mockUpdate.mockReturnValue({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.broadcastFirmwareUpdate({ plaza: "Lagos-Ibadan Toll" });

    // sent=1 because device firmware (2.4.1) !== latestFirmware (2.5.0)
    expect(result.sent).toBe(1);
    expect(result.total).toBe(1);
    // The result entry should have the device's latestFirmware as targetVersion
    expect(result.results[0].targetVersion).toBe("2.5.0");
  });

  it("rejects broadcastFirmwareUpdate for non-admin user", async () => {
    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("user"));

    await expect(
      caller.broadcastFirmwareUpdate({ plaza: "Lagos-Ibadan Toll", targetVersion: "2.4.2" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("includes serial and name in each result entry", async () => {
    const d1 = seedDevice({ plaza: "Lagos-Ibadan Toll", serial: "NFC-LOS-001", name: "Gate 1 Reader" });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([d1]),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.broadcastFirmwareUpdate({ plaza: "Lagos-Ibadan Toll", targetVersion: "2.4.2" });

    expect(result.results[0].serial).toBe("NFC-LOS-001");
    expect(result.results[0].name).toBe("Gate 1 Reader");
  });
});

// ── ussd.getSessionStats tests ────────────────────────────────────────────────

describe("ussd.getSessionStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns zero stats when DB returns no rows", async () => {
    // Mock DB returning empty aggregates for all three queries
    const emptyAgg = { total: 0, completed: 0, avgInteractions: 0, avgDuration: null };
    mockSelect
      .mockReturnValueOnce({
        from: () => ({ where: () => Promise.resolve([emptyAgg]) }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            groupBy: () => ({
              orderBy: () => ({ limit: () => Promise.resolve([]) }),
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            groupBy: () => ({
              orderBy: () => Promise.resolve([]),
            }),
          }),
        }),
      });

    const { ussdRouter } = await import("../server/routers/ussd");
    const caller = ussdRouter.createCaller(makeCtx("admin"));

    const result = await caller.getSessionStats({ days: 30 });

    expect(result.totalSessions).toBe(0);
    expect(result.completedSessions).toBe(0);
    expect(result.completionRate).toBe(0);
    expect(result.source).toBe("db");
  });

  it("calculates completionRate correctly from totals", async () => {
    // First select call returns aggregates
    mockSelect
      .mockReturnValueOnce({
        from: () => ({
          where: () => Promise.resolve([{ total: 100, completed: 75, avgInteractions: 3.2, avgDuration: 45 }]),
        }),
      })
      // Second select call returns top paths
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            groupBy: () => ({
              orderBy: () => ({
                limit: () => Promise.resolve([
                  { path: "1>1", count: 40 },
                  { path: "1>2", count: 25 },
                ]),
              }),
            }),
          }),
        }),
      })
      // Third select call returns daily counts
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            groupBy: () => ({
              orderBy: () => Promise.resolve([
                { date: "2026-03-01", total: 50, completed: 38 },
                { date: "2026-03-02", total: 50, completed: 37 },
              ]),
            }),
          }),
        }),
      });

    const { ussdRouter } = await import("../server/routers/ussd");
    const caller = ussdRouter.createCaller(makeCtx("admin"));

    const result = await caller.getSessionStats({ days: 30 });

    expect(result.totalSessions).toBe(100);
    expect(result.completedSessions).toBe(75);
    expect(result.completionRate).toBe(75);
    expect(result.avgInteractions).toBe(3.2);
    expect(result.avgDurationSeconds).toBe(45);
    expect(result.source).toBe("db");
  });

  it("rejects getSessionStats for non-authenticated user", async () => {
    const { ussdRouter } = await import("../server/routers/ussd");
    // No user in context = unauthenticated
    const caller = ussdRouter.createCaller({
      user: null as never,
      req: {} as never,
      res: {} as never,
    });

    await expect(caller.getSessionStats({ days: 30 }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
