/**
 * Device v13 Feature Tests
 * ========================
 * Verifies:
 *  - devices.reportFirmwareVersion — admin-only, NOT_FOUND, updates firmware field,
 *    isUpToDate flag, notifyOwner called when update completes
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Shared mock DB state ───────────────────────────────────────────────────────

type MockDevice = {
  id: number; serial: string; name: string; type: string;
  plaza: string; lane: string; status: string; firmware: string;
  latestFirmware: string; uptime: string; cpu: number; memory: number;
  temp: number; alerts: number; lastSeen: Date; createdAt: Date; updatedAt: Date;
};

let mockDevices: Record<number, MockDevice> = {};
let nextDeviceId = 1;

function resetDb() {
  mockDevices = {};
  nextDeviceId = 1;
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
  return mockDevices[id];
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

// ── reportFirmwareVersion tests ───────────────────────────────────────────────

describe("devices.reportFirmwareVersion", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
  });

  it("returns success with previousFirmware and currentFirmware for a valid device", async () => {
    const device = seedDevice({ id: 1, serial: "NFC-LOS-001", firmware: "2.4.1", latestFirmware: "2.4.2" });
    const updated = { ...device, firmware: "2.4.2" };

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([device]),
        }),
      }),
    });
    mockUpdate.mockReturnValue({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([updated]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.reportFirmwareVersion({ serial: "NFC-LOS-001", version: "2.4.2" });

    expect(result.success).toBe(true);
    expect(result.serial).toBe("NFC-LOS-001");
    expect(result.previousFirmware).toBe("2.4.1");
    expect(result.currentFirmware).toBe("2.4.2");
    expect(result.isUpToDate).toBe(true);
    expect(result.updatedAt).toBeTruthy();
  });

  it("sets isUpToDate=false when reported version differs from latestFirmware", async () => {
    const device = seedDevice({ id: 1, serial: "NFC-LOS-001", firmware: "2.4.0", latestFirmware: "2.4.2" });
    const updated = { ...device, firmware: "2.4.1" };

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([device]),
        }),
      }),
    });
    mockUpdate.mockReturnValue({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([updated]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.reportFirmwareVersion({ serial: "NFC-LOS-001", version: "2.4.1" });

    expect(result.isUpToDate).toBe(false);
    expect(result.latestFirmware).toBe("2.4.2");
  });

  it("calls notifyOwner when device successfully updates to latestFirmware", async () => {
    // Device was outdated (firmware !== latestFirmware)
    const device = seedDevice({ id: 1, serial: "NFC-LOS-001", firmware: "2.4.1", latestFirmware: "2.4.2" });
    const updated = { ...device, firmware: "2.4.2" };

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([device]),
        }),
      }),
    });
    mockUpdate.mockReturnValue({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([updated]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    await caller.reportFirmwareVersion({ serial: "NFC-LOS-001", version: "2.4.2" });

    // notifyOwner should have been called (fire-and-forget, so may be pending)
    expect(mockNotifyOwner).toHaveBeenCalledOnce();
    const callArg = mockNotifyOwner.mock.calls[0][0] as { title: string; content: string };
    expect(callArg.title).toContain("NFC-LOS-001");
    expect(callArg.content).toContain("2.4.2");
  });

  it("does NOT call notifyOwner when device was already on latestFirmware", async () => {
    // Device is already up to date — firmware === latestFirmware
    const device = seedDevice({ id: 1, serial: "NFC-LOS-001", firmware: "2.4.2", latestFirmware: "2.4.2" });
    const updated = { ...device };

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([device]),
        }),
      }),
    });
    mockUpdate.mockReturnValue({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([updated]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    await caller.reportFirmwareVersion({ serial: "NFC-LOS-001", version: "2.4.2" });

    expect(mockNotifyOwner).not.toHaveBeenCalled();
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

    await expect(caller.reportFirmwareVersion({ serial: "NONEXISTENT", version: "2.4.2" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects reportFirmwareVersion for non-admin user", async () => {
    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("user"));

    await expect(caller.reportFirmwareVersion({ serial: "NFC-LOS-001", version: "2.4.2" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
