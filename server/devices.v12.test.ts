/**
 * Device v12 Feature Tests
 * ========================
 * Verifies:
 *  - devices.validateQrCode       — HMAC verification, expiry check, scheme validation
 *  - devices.triggerFirmwareUpdate — admin-only, NOT_FOUND, BAD_REQUEST (already on version), WS broadcast
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "crypto";

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

const mockEmitDeviceHeartbeat = vi.fn();

vi.mock("../server/deviceHeartbeat", () => ({
  emitDeviceHeartbeat: mockEmitDeviceHeartbeat,
}));

// ── Mock notification module ───────────────────────────────────────────────────

vi.mock("../server/_core/notification", () => ({
  notifyOwner: vi.fn().mockResolvedValue(true),
}));

// ── QR signing secret ─────────────────────────────────────────────────────────
// The QR HMAC fallback secret was removed (audit v13, P0-6): the router now
// requires NFC_MASTER_SECRET (or JWT_SECRET) to be configured and throws
// PRECONDITION_FAILED otherwise. Provide a deterministic test secret so the
// test-side HMAC matches the server-side HMAC.
const TEST_QR_SECRET = "test-qr-signing-secret";

// ── Helper to build a mock tRPC context ───────────────────────────────────────

function makeCtx(role: "admin" | "user" | "operator" = "admin") {
  return {
    user: { id: 1, openId: "test-open-id", name: "Admin User", role },
    req: {} as never,
    res: {} as never,
  };
}

// ── Helper to build a valid signed QR URI ─────────────────────────────────────

function buildSignedUri(serial: string, plaza: string, lane: string, ttlMs = 24 * 3_600_000): string {
  const ts = Date.now();
  const exp = ts + ttlMs;
  const secret = TEST_QR_SECRET;
  const payload = `nigerianpass://station/${serial}?plaza=${encodeURIComponent(plaza)}&lane=${encodeURIComponent(lane)}&ts=${ts}&exp=${exp}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
  return `${payload}&sig=${sig}`;
}

function buildLegacyUri(serial: string, plaza: string, lane: string): string {
  // Legacy URI without exp field
  const ts = Date.now();
  const secret = TEST_QR_SECRET;
  const payload = `nigerianpass://station/${serial}?plaza=${encodeURIComponent(plaza)}&lane=${encodeURIComponent(lane)}&ts=${ts}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
  return `${payload}&sig=${sig}`;
}

// ── validateQrCode tests ──────────────────────────────────────────────────────

describe("devices.validateQrCode", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
    // QR HMAC secret must be configured — no fallback exists anymore.
    // Stubbed before the dynamic router import so ENV picks it up.
    vi.stubEnv("NFC_MASTER_SECRET", TEST_QR_SECRET);
    vi.stubEnv("JWT_SECRET", TEST_QR_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns valid=true for a correctly signed, non-expired URI", async () => {
    const uri = buildSignedUri("NFC-LOS-001", "Lagos-Ibadan Toll", "Lane 1");

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.validateQrCode({ uri });

    expect(result.valid).toBe(true);
    expect(result.reason).toBe("OK");
    expect(result.serial).toBe("NFC-LOS-001");
    expect(result.plaza).toBe("Lagos-Ibadan Toll");
    expect(result.lane).toBe("Lane 1");
    expect(result.expiresAt).toBeTruthy();
  });

  it("returns valid=false for a tampered signature", async () => {
    const uri = buildSignedUri("NFC-LOS-001", "Lagos-Ibadan Toll", "Lane 1");
    // Tamper the last character of the sig
    const tampered = uri.slice(0, -1) + (uri.endsWith("a") ? "b" : "a");

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.validateQrCode({ uri: tampered });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Signature mismatch");
  });

  it("returns valid=false for an expired URI", async () => {
    // Build a URI that expired 1 hour ago
    const serial = "NFC-LOS-001";
    const plaza = "Lagos-Ibadan Toll";
    const lane = "Lane 1";
    const ts = Date.now() - 2 * 3_600_000; // 2 hours ago
    const exp = ts + 1 * 3_600_000;         // expired 1 hour ago
    const secret = TEST_QR_SECRET;
    const payload = `nigerianpass://station/${serial}?plaza=${encodeURIComponent(plaza)}&lane=${encodeURIComponent(lane)}&ts=${ts}&exp=${exp}`;
    const sig = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
    const uri = `${payload}&sig=${sig}`;

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.validateQrCode({ uri });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("expired");
    expect(result.expiresAt).toBeTruthy();
  });

  it("returns valid=false for wrong URI scheme", async () => {
    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.validateQrCode({ uri: "https://example.com/station/NFC-LOS-001" });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Invalid URI scheme");
  });

  it("returns valid=false when sig parameter is missing", async () => {
    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.validateQrCode({ uri: "nigerianpass://station/NFC-LOS-001?plaza=Lagos&lane=Lane1&ts=12345" });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Missing or malformed signature");
  });

  it("returns valid=true with no expiry for legacy URI (no exp field)", async () => {
    const uri = buildLegacyUri("NFC-LOS-001", "Lagos-Ibadan Toll", "Lane 1");

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.validateQrCode({ uri });

    expect(result.valid).toBe(true);
    expect(result.reason).toContain("no expiry");
    expect(result.expiresAt).toBeNull();
  });

  // validateQrCode is operator/admin-gated (audit hardening) — it is no longer
  // a public endpoint for gate controllers.
  it("rejects validation by a plain non-operator/non-admin user", async () => {
    const uri = buildSignedUri("NFC-LOS-001", "Lagos-Ibadan Toll", "Lane 1");

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("user"));

    await expect(caller.validateQrCode({ uri }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("operator role can validate QR codes (gate controller access)", async () => {
    const uri = buildSignedUri("NFC-LOS-001", "Lagos-Ibadan Toll", "Lane 1");

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("operator"));

    const result = await caller.validateQrCode({ uri });

    expect(result.valid).toBe(true);
  });
});

// ── triggerFirmwareUpdate tests ───────────────────────────────────────────────

describe("devices.triggerFirmwareUpdate", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
  });

  it("returns success with serial, current and target firmware for a valid device", async () => {
    const device = seedDevice({ id: 1, serial: "NFC-LOS-001", firmware: "2.4.1", latestFirmware: "2.4.2" });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([device]),
        }),
      }),
    });
    mockUpdate.mockReturnValue({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.triggerFirmwareUpdate({ serial: "NFC-LOS-001", targetVersion: "2.4.2" });

    expect(result.success).toBe(true);
    expect(result.serial).toBe("NFC-LOS-001");
    expect(result.currentFirmware).toBe("2.4.1");
    expect(result.targetVersion).toBe("2.4.2");
    expect(result.requestedAt).toBeTruthy();
  });

  it("broadcasts firmware_update_requested via emitDeviceHeartbeat", async () => {
    const device = seedDevice({ id: 1, serial: "NFC-LOS-001", firmware: "2.4.1" });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([device]),
        }),
      }),
    });
    mockUpdate.mockReturnValue({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    await caller.triggerFirmwareUpdate({ serial: "NFC-LOS-001", targetVersion: "2.4.2" });

    expect(mockEmitDeviceHeartbeat).toHaveBeenCalledOnce();
    const emitArg = mockEmitDeviceHeartbeat.mock.calls[0][0];
    expect(emitArg.serial).toBe("NFC-LOS-001");
    expect((emitArg as Record<string, unknown>).event).toBe("firmware_update_requested");
    expect((emitArg as Record<string, unknown>).targetVersion).toBe("2.4.2");
  });

  it("throws BAD_REQUEST when device is already on the target firmware version", async () => {
    const device = seedDevice({ id: 1, serial: "NFC-LOS-001", firmware: "2.4.2" });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([device]),
        }),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    await expect(caller.triggerFirmwareUpdate({ serial: "NFC-LOS-001", targetVersion: "2.4.2" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
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

    await expect(caller.triggerFirmwareUpdate({ serial: "NONEXISTENT", targetVersion: "2.4.2" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects triggerFirmwareUpdate for non-admin user", async () => {
    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("user"));

    await expect(caller.triggerFirmwareUpdate({ serial: "NFC-LOS-001", targetVersion: "2.4.2" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("requestedBy is set to the caller's name", async () => {
    const device = seedDevice({ id: 1, serial: "NFC-LOS-001", firmware: "2.4.1" });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([device]),
        }),
      }),
    });
    mockUpdate.mockReturnValue({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.triggerFirmwareUpdate({ serial: "NFC-LOS-001", targetVersion: "2.4.2" });

    expect(result.requestedBy).toBe("Admin User");
  });
});
