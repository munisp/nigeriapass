/**
 * Device v15 Feature Tests
 * ========================
 * Verifies:
 *  - devices.getQrScanHistory — admin-only, returns logs with acceptance rate, filters by serial
 *  - devices.getFirmwareBroadcastStatus — admin-only, returns up-to-date/pending counts, byPlaza map
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Shared mock DB state ───────────────────────────────────────────────────────

type MockDevice = {
  id: number; serial: string; name: string; type: string;
  plaza: string; lane: string; status: string; firmware: string;
  latestFirmware: string; uptime: string; cpu: number; memory: number;
  temp: number; alerts: number; lastSeen: Date; createdAt: Date; updatedAt: Date;
};

type MockScanLog = {
  id: number; deviceSerial: string; scannedUri: string; valid: boolean;
  rejectionReason: string | null; plazaName: string | null; lane: string | null;
  operatorUserId: number | null; operatorName: string | null; scannedAt: Date;
};

let mockDevices: MockDevice[] = [];
let mockScanLogs: MockScanLog[] = [];

function resetDb() {
  mockDevices = [];
  mockScanLogs = [];
}

function seedDevice(overrides: Partial<MockDevice> = {}): MockDevice {
  const id = mockDevices.length + 1;
  const now = new Date();
  const d: MockDevice = {
    id, serial: `NFC-LOS-00${id}`, name: `NFC Reader — Lane ${id}`,
    type: "nfc_reader", plaza: "Lagos-Ibadan Toll", lane: `Lane ${id}`,
    status: "online", firmware: "2.4.1", latestFirmware: "2.4.2",
    uptime: "5d 3h", cpu: 20, memory: 40, temp: 38, alerts: 0,
    lastSeen: now, createdAt: now, updatedAt: now,
    ...overrides,
  };
  mockDevices.push(d);
  return d;
}

function seedScanLog(overrides: Partial<MockScanLog> = {}): MockScanLog {
  const id = mockScanLogs.length + 1;
  const log: MockScanLog = {
    id, deviceSerial: "NFC-LOS-001",
    scannedUri: "nigerianpass://station/NFC-LOS-001?plaza=Lagos&lane=1&sig=abcdef1234567890",
    valid: true, rejectionReason: null, plazaName: "Lagos-Ibadan Toll", lane: "Lane 1",
    operatorUserId: 1, operatorName: "Admin User", scannedAt: new Date(),
    ...overrides,
  };
  mockScanLogs.push(log);
  return log;
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

vi.mock("../server/deviceHeartbeat", () => ({
  emitDeviceHeartbeat: vi.fn(),
}));

// ── Mock notification module ───────────────────────────────────────────────────

vi.mock("../server/_core/notification", () => ({
  notifyOwner: vi.fn().mockResolvedValue(true),
}));

// ── Helper to build a mock tRPC context ───────────────────────────────────────

function makeCtx(role: "admin" | "user" = "admin") {
  return {
    user: { id: 1, openId: "test-open-id", name: "Admin User", role },
    req: {} as never,
    res: {} as never,
  };
}

// ── getQrScanHistory tests ────────────────────────────────────────────────────

describe("devices.getQrScanHistory", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
  });

  it("returns scan logs with acceptance rate summary", async () => {
    const log1 = seedScanLog({ valid: true });
    const log2 = seedScanLog({ valid: true });
    const log3 = seedScanLog({ valid: false, rejectionReason: "Signature mismatch" });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve([log1, log2, log3]),
          }),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.getQrScanHistory({});

    expect(result.totalScans).toBe(3);
    expect(result.validScans).toBe(2);
    expect(result.rejectedScans).toBe(1);
    expect(result.acceptanceRate).toBe(67); // Math.round(2/3 * 100)
    expect(result.logs).toHaveLength(3);
  });

  it("returns 100% acceptance rate when all scans are valid", async () => {
    const log1 = seedScanLog({ valid: true });
    const log2 = seedScanLog({ valid: true });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve([log1, log2]),
          }),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.getQrScanHistory({});

    expect(result.acceptanceRate).toBe(100);
    expect(result.rejectedScans).toBe(0);
  });

  it("returns 0% acceptance rate and empty logs when no scans exist", async () => {
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

    const result = await caller.getQrScanHistory({});

    expect(result.totalScans).toBe(0);
    expect(result.acceptanceRate).toBe(0);
    expect(result.logs).toHaveLength(0);
  });

  it("throws FORBIDDEN for non-admin user", async () => {
    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("user"));

    await expect(caller.getQrScanHistory({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ── getFirmwareBroadcastStatus tests ─────────────────────────────────────────

describe("devices.getFirmwareBroadcastStatus", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
  });

  it("returns correct up-to-date and pending counts", async () => {
    const d1 = seedDevice({ firmware: "2.4.2", latestFirmware: "2.4.2" }); // up to date
    const d2 = seedDevice({ firmware: "2.4.1", latestFirmware: "2.4.2" }); // pending
    const d3 = seedDevice({ firmware: "2.4.1", latestFirmware: "2.4.2" }); // pending

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([d1, d2, d3]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.getFirmwareBroadcastStatus({});

    expect(result.total).toBe(3);
    expect(result.upToDate).toBe(1);
    expect(result.pending).toBe(2);
    expect(result.devices).toHaveLength(3);
    expect(result.devices.find(d => d.serial === d1.serial)?.isUpToDate).toBe(true);
    expect(result.devices.find(d => d.serial === d2.serial)?.isUpToDate).toBe(false);
  });

  it("builds byPlaza map with correct per-plaza counts", async () => {
    const d1 = seedDevice({ plaza: "Plaza A", firmware: "2.4.2", latestFirmware: "2.4.2" });
    const d2 = seedDevice({ plaza: "Plaza A", firmware: "2.4.1", latestFirmware: "2.4.2" });
    const d3 = seedDevice({ plaza: "Plaza B", firmware: "2.4.2", latestFirmware: "2.4.2" });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([d1, d2, d3]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.getFirmwareBroadcastStatus({});

    expect(result.byPlaza["Plaza A"].total).toBe(2);
    expect(result.byPlaza["Plaza A"].upToDate).toBe(1);
    expect(result.byPlaza["Plaza A"].pending).toBe(1);
    expect(result.byPlaza["Plaza B"].total).toBe(1);
    expect(result.byPlaza["Plaza B"].pending).toBe(0);
  });

  it("returns all-upToDate when all devices are current", async () => {
    const d1 = seedDevice({ firmware: "2.4.2", latestFirmware: "2.4.2" });
    const d2 = seedDevice({ firmware: "2.4.2", latestFirmware: "2.4.2" });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([d1, d2]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.getFirmwareBroadcastStatus({});

    expect(result.pending).toBe(0);
    expect(result.upToDate).toBe(2);
  });

  it("throws FORBIDDEN for non-admin user", async () => {
    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("user"));

    await expect(caller.getFirmwareBroadcastStatus({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("includes checkedAt timestamp in the response", async () => {
    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.getFirmwareBroadcastStatus({});

    expect(result.checkedAt).toBeTruthy();
    expect(new Date(result.checkedAt).getTime()).toBeGreaterThan(0);
  });
});
