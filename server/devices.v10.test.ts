/**
 * Device v10 Feature Tests
 * ========================
 * Verifies:
 *  - devices.resolveAlert  — clears alert count, persists note, admin-only
 *  - devices.printPlazaQrSheet — generates A4 PDF with QR codes for all NFC readers at a plaza
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Shared mock DB state ───────────────────────────────────────────────────────

type MockDevice = {
  id: number; serial: string; name: string; type: string;
  plaza: string; lane: string; status: string; firmware: string;
  latestFirmware: string; uptime: string; cpu: number; memory: number;
  temp: number; alerts: number; lastSeen: Date; createdAt: Date; updatedAt: Date;
};

let mockDevices: Record<number, MockDevice> = {};
let nextId = 1;

function resetDb() {
  mockDevices = {};
  nextId = 1;
}

function seedDevice(overrides: Partial<MockDevice> = {}): MockDevice {
  const id = nextId++;
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
    alerts: 3,
    lastSeen: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  return mockDevices[id];
}

// ── Mock the DB module ─────────────────────────────────────────────────────────

const mockUpdate = vi.fn();
const mockSelect = vi.fn();
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
    user: { id: 1, openId: "test-open-id", name: "Test User", role },
    req: {} as never,
    res: {} as never,
  };
}

// ── resolveAlert tests ────────────────────────────────────────────────────────

describe("devices.resolveAlert", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
  });

  it("clears alerts and returns success for a device with active alerts", async () => {
    const device = seedDevice({ id: 1, serial: "NFC-LOS-001", alerts: 5 });

    // resolveAlert makes two select calls: first for id/serial/alerts, second for plaza
    const selectResult = {
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: device.id, serial: device.serial, alerts: device.alerts, plaza: device.plaza }]),
        }),
      }),
    };
    mockSelect.mockReturnValue(selectResult);

    // update resolves
    mockUpdate.mockReturnValue({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    });

    // insert (audit log) resolves
    mockInsert.mockReturnValue({
      values: () => Promise.resolve(),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.resolveAlert({ id: 1, note: "Replaced faulty antenna" });

    expect(result.success).toBe(true);
    expect(result.serial).toBe("NFC-LOS-001");
    expect(result.alertsCleared).toBe(5);
    expect(result.note).toBe("Replaced faulty antenna");
    expect(result.resolvedAt).toBeTruthy();
    // Verify update was called
    expect(mockUpdate).toHaveBeenCalledOnce();
  });

  it("returns alertsCleared = 0 without calling update when device has no alerts", async () => {
    const device = seedDevice({ id: 2, serial: "NFC-LOS-002", alerts: 0 });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: device.id, serial: device.serial, alerts: 0 }]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.resolveAlert({ id: 2 });

    expect(result.success).toBe(true);
    expect(result.alertsCleared).toBe(0);
    // update should NOT have been called since alerts = 0
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("accepts resolveAlert without a note (note is optional)", async () => {
    const device = seedDevice({ id: 3, serial: "NFC-LOS-003", alerts: 2 });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: device.id, serial: device.serial, alerts: 2, plaza: device.plaza }]),
        }),
      }),
    });
    mockUpdate.mockReturnValue({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    });
    mockInsert.mockReturnValue({
      values: () => Promise.resolve(),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.resolveAlert({ id: 3 });

    expect(result.success).toBe(true);
    expect(result.note).toBeNull();
  });

  it("throws NOT_FOUND when device does not exist", async () => {
    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]), // empty
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    await expect(caller.resolveAlert({ id: 9999 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects resolveAlert by non-admin user", async () => {
    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("user"));

    await expect(caller.resolveAlert({ id: 1 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("resolvedAt is a valid ISO timestamp", async () => {
    const device = seedDevice({ id: 4, serial: "NFC-LOS-004", alerts: 1 });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: device.id, serial: device.serial, alerts: 1, plaza: device.plaza }]),
        }),
      }),
    });
    mockUpdate.mockReturnValue({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    });
    mockInsert.mockReturnValue({
      values: () => Promise.resolve(),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const before = new Date().toISOString();
    const result = await caller.resolveAlert({ id: 4 });
    const after = new Date().toISOString();

    expect(result.resolvedAt).toBeTruthy();
    expect(result.resolvedAt! >= before).toBe(true);
    expect(result.resolvedAt! <= after).toBe(true);
  });
});

// ── printPlazaQrSheet tests ───────────────────────────────────────────────────

describe("devices.printPlazaQrSheet", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
    // QR HMAC secret fallback was removed (audit v13, P0-6): the router throws
    // PRECONDITION_FAILED when no signing secret is configured. Provide one
    // (stubbed before the dynamic router import so ENV picks it up).
    vi.stubEnv("NFC_MASTER_SECRET", "test-qr-signing-secret");
    vi.stubEnv("JWT_SECRET", "test-qr-signing-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a base64 PDF with correct metadata for a plaza with NFC readers", async () => {
    const d1 = seedDevice({ id: 1, serial: "NFC-LOS-001", type: "nfc_reader", plaza: "Lagos-Ibadan Toll", lane: "Lane 1" });
    const d2 = seedDevice({ id: 2, serial: "NFC-LOS-002", type: "nfc_reader", plaza: "Lagos-Ibadan Toll", lane: "Lane 2" });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([d1, d2]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.printPlazaQrSheet({ plaza: "Lagos-Ibadan Toll" });

    expect(result.plaza).toBe("Lagos-Ibadan Toll");
    expect(result.readerCount).toBe(2);
    expect(result.filename).toMatch(/^nigerianpass-qr-sheet-lagos-ibadan-toll-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(result.pdfBase64).toBeTruthy();
    // Verify it's valid base64 that decodes to a PDF header (%PDF)
    const bytes = Buffer.from(result.pdfBase64, "base64");
    expect(bytes.slice(0, 4).toString()).toBe("%PDF");
  }, 15_000); // PDF generation can take a few seconds

  it("throws NOT_FOUND when no NFC readers exist at the plaza", async () => {
    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([]), // empty
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    await expect(caller.printPlazaQrSheet({ plaza: "Empty Plaza" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects printPlazaQrSheet by non-admin user", async () => {
    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("user"));

    await expect(caller.printPlazaQrSheet({ plaza: "Lagos-Ibadan Toll" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("filename includes the plaza name (slugified) and today's date", async () => {
    const d1 = seedDevice({ id: 1, serial: "NFC-ABJ-001", type: "nfc_reader", plaza: "Abuja Keffi Toll", lane: "Lane 1" });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([d1]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.printPlazaQrSheet({ plaza: "Abuja Keffi Toll" });
    const today = new Date().toISOString().slice(0, 10);

    expect(result.filename).toContain("abuja-keffi-toll");
    expect(result.filename).toContain(today);
  }, 15_000);

  it("PDF for a single NFC reader is non-trivial in size (contains QR image data)", async () => {
    const d1 = seedDevice({ id: 1, serial: "NFC-KAN-001", type: "nfc_reader", plaza: "Kano Toll", lane: "Lane 1" });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve([d1]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.printPlazaQrSheet({ plaza: "Kano Toll" });

    // A PDF with an embedded QR PNG image should be at least 5 KB
    const bytes = Buffer.from(result.pdfBase64, "base64");
    expect(bytes.length).toBeGreaterThan(5_000);
    // And the base64 string itself should be non-trivial
    expect(result.pdfBase64.length).toBeGreaterThan(6_000);
  }, 15_000);
});
