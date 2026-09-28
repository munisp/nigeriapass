/**
 * Device v11 Feature Tests
 * ========================
 * Verifies:
 *  - devices.getAlertHistory  — returns alert log entries for a device, admin-only
 *  - devices.rotateQrCode     — generates a new signed URI with expiry, admin-only
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Shared mock DB state ───────────────────────────────────────────────────────

type MockDevice = {
  id: number; serial: string; name: string; type: string;
  plaza: string; lane: string; status: string; firmware: string;
  latestFirmware: string; uptime: string; cpu: number; memory: number;
  temp: number; alerts: number; lastSeen: Date; createdAt: Date; updatedAt: Date;
};

type MockAlertLog = {
  id: number; deviceId: number; serial: string; plaza: string;
  alertsCleared: number; note: string | null; resolvedByUserId: number;
  resolvedByName: string | null; resolvedAt: Date; createdAt: Date;
};

let mockDevices: Record<number, MockDevice> = {};
let mockAlertLogs: MockAlertLog[] = [];
let nextDeviceId = 1;
let nextLogId = 1;

function resetDb() {
  mockDevices = {};
  mockAlertLogs = [];
  nextDeviceId = 1;
  nextLogId = 1;
}

function seedDevice(overrides: Partial<MockDevice> = {}): MockDevice {
  const id = nextDeviceId++;
  const now = new Date();
  mockDevices[id] = {
    id,
    serial: `NFC-LOS-00${id}`,
    name: `NFC Reader — Lane ${id}`,
    type: "nfc_reader",
    plaza: "Lagos-Ibadan Toll",
    lane: `Lane ${id}`,
    status: "online",
    firmware: "2.4.1",
    latestFirmware: "2.4.1",
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
  return mockDevices[id];
}

function seedAlertLog(overrides: Partial<MockAlertLog> = {}): MockAlertLog {
  const id = nextLogId++;
  const now = new Date();
  const log: MockAlertLog = {
    id,
    deviceId: 1,
    serial: "NFC-LOS-001",
    plaza: "Lagos-Ibadan Toll",
    alertsCleared: 3,
    note: null,
    resolvedByUserId: 1,
    resolvedByName: "Admin User",
    resolvedAt: now,
    createdAt: now,
    ...overrides,
  };
  mockAlertLogs.push(log);
  return log;
}

// ── Mock the DB module ─────────────────────────────────────────────────────────

const mockSelect = vi.fn();
const mockUpdate = vi.fn();
const mockInsert = vi.fn();

vi.mock("../server/db", () => ({
  getDb: vi.fn().mockImplementation(() => {
    return Promise.resolve({
      select: mockSelect,
      update: mockUpdate,
      insert: mockInsert,
    });
  }),
}));

// ── Mock deviceHeartbeat module ────────────────────────────────────────────────

vi.mock("../server/deviceHeartbeat", () => ({
  emitDeviceHeartbeat: vi.fn(),
}));

// ── Helper to build a mock tRPC context ───────────────────────────────────────

function makeCtx(role: "admin" | "user" = "admin") {
  return {
    user: { id: 1, openId: "test-open-id", name: "Admin User", role },
    req: {} as never,
    res: {} as never,
  };
}

// ── getAlertHistory tests ─────────────────────────────────────────────────────

describe("devices.getAlertHistory", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
  });

  it("returns alert log entries for a device ordered by most recent first", async () => {
    const log1 = seedAlertLog({ id: 1, deviceId: 10, alertsCleared: 2, note: "Fixed antenna" });
    const log2 = seedAlertLog({ id: 2, deviceId: 10, alertsCleared: 5, note: null });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve([log2, log1]), // most recent first
          }),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.getAlertHistory({ deviceId: 10 });

    expect(result).toHaveLength(2);
    expect(result[0].alertsCleared).toBe(5);
    expect(result[1].alertsCleared).toBe(2);
    expect(result[1].note).toBe("Fixed antenna");
  });

  it("returns empty array when device has no alert history", async () => {
    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.getAlertHistory({ deviceId: 999 });

    expect(result).toHaveLength(0);
  });

  it("rejects getAlertHistory for non-admin user", async () => {
    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("user"));

    await expect(caller.getAlertHistory({ deviceId: 1 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("respects the limit parameter", async () => {
    const logs = Array.from({ length: 10 }, (_, i) =>
      seedAlertLog({ id: i + 1, deviceId: 5, alertsCleared: i + 1 })
    );

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve(logs.slice(0, 5)),
          }),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.getAlertHistory({ deviceId: 5, limit: 5 });

    expect(result).toHaveLength(5);
  });

  it("returns resolvedByName in each entry", async () => {
    const log = seedAlertLog({ deviceId: 7, resolvedByName: "Chukwuemeka Obi" });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve([log]),
          }),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.getAlertHistory({ deviceId: 7 });

    expect(result[0].resolvedByName).toBe("Chukwuemeka Obi");
  });
});

// ── rotateQrCode tests ────────────────────────────────────────────────────────

describe("devices.rotateQrCode", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
  });

  it("returns a signed QR URI with expiry for a valid NFC reader device", async () => {
    const device = seedDevice({ id: 1, serial: "NFC-LOS-001", plaza: "Lagos-Ibadan Toll", lane: "Lane 1" });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([device]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.rotateQrCode({ serial: "NFC-LOS-001" });

    expect(result.serial).toBe("NFC-LOS-001");
    expect(result.qrUri).toMatch(/^nigerianpass:\/\/station\/NFC-LOS-001\?/);
    expect(result.qrUri).toContain("&exp=");
    expect(result.qrUri).toContain("&sig=");
    expect(result.expiresAt).toBeTruthy();
    expect(result.ttlHours).toBe(24); // default TTL
  });

  it("expiry timestamp is approximately ttlHours in the future", async () => {
    const device = seedDevice({ id: 1, serial: "NFC-LOS-001", plaza: "Lagos-Ibadan Toll", lane: "Lane 1" });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([device]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const before = Date.now();
    const result = await caller.rotateQrCode({ serial: "NFC-LOS-001", ttlHours: 48 });
    const after = Date.now();

    const expiresMs = new Date(result.expiresAt).getTime();
    const expectedMin = before + 48 * 3_600_000;
    const expectedMax = after + 48 * 3_600_000;

    expect(expiresMs).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresMs).toBeLessThanOrEqual(expectedMax);
    expect(result.ttlHours).toBe(48);
  });

  it("HMAC signature is exactly 16 hex characters", async () => {
    const device = seedDevice({ id: 1, serial: "NFC-LOS-001", plaza: "Lagos-Ibadan Toll", lane: "Lane 1" });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([device]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.rotateQrCode({ serial: "NFC-LOS-001" });

    const sigMatch = result.qrUri.match(/&sig=([0-9a-f]+)$/);
    expect(sigMatch).not.toBeNull();
    expect(sigMatch![1]).toHaveLength(16);
  });

  it("throws NOT_FOUND when device does not exist", async () => {
    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    await expect(caller.rotateQrCode({ serial: "NONEXISTENT" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects rotateQrCode for non-admin user", async () => {
    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("user"));

    await expect(caller.rotateQrCode({ serial: "NFC-LOS-001" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("each rotation produces a different signature (different timestamp)", async () => {
    const device = seedDevice({ id: 1, serial: "NFC-LOS-001", plaza: "Lagos-Ibadan Toll", lane: "Lane 1" });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([device]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result1 = await caller.rotateQrCode({ serial: "NFC-LOS-001" });
    // Small delay to ensure different timestamp
    await new Promise(r => setTimeout(r, 5));
    const result2 = await caller.rotateQrCode({ serial: "NFC-LOS-001" });

    // URIs should differ (different ts/exp/sig)
    expect(result1.qrUri).not.toBe(result2.qrUri);
  });
});
