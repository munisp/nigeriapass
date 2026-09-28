/**
 * Device QR Code & Heartbeat Tests
 * =================================
 * Verifies:
 *  - devices.getPlazaQrCode — signed QR URI generation for NFC reader stations
 *  - devices.simulateHeartbeat — emits a heartbeat event for a known device
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TRPCError } from "@trpc/server";

// ── Shared mock DB state ───────────────────────────────────────────────────────

let mockDevices: Record<number, {
  id: number; serial: string; name: string; type: string;
  plaza: string; lane: string; status: string; firmware: string;
  latestFirmware: string; uptime: string; cpu: number; memory: number;
  temp: number; alerts: number; lastSeen: Date; createdAt: Date; updatedAt: Date;
}> = {};
let nextId = 1;

function resetDb() {
  mockDevices = {};
  nextId = 1;
}

function seedDevice(overrides: Partial<typeof mockDevices[number]> = {}) {
  const id = nextId++;
  const now = new Date();
  mockDevices[id] = {
    id,
    serial: "NFC-LOS-001",
    name: "NFC Reader — Lane 1",
    type: "nfc_reader",
    plaza: "Lagos-Ibadan Toll",
    lane: "Lane 1",
    status: "online",
    firmware: "2.4.1",
    latestFirmware: "2.4.1",
    uptime: "14d 6h",
    cpu: 12,
    memory: 34,
    temp: 42,
    alerts: 0,
    lastSeen: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  return mockDevices[id];
}

// ── Mock the DB module ─────────────────────────────────────────────────────────

vi.mock("../server/db", () => ({
  getDb: vi.fn().mockResolvedValue({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(Object.values(mockDevices).slice(0, 1)),
          orderBy: () => Promise.resolve(Object.values(mockDevices)),
        }),
        orderBy: () => Promise.resolve(Object.values(mockDevices)),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => Promise.resolve([Object.values(mockDevices)[0]]),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: () => Promise.resolve([Object.values(mockDevices)[0]]),
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: () => Promise.resolve([]),
      }),
    }),
  }),
}));

// ── Mock deviceHeartbeat module ────────────────────────────────────────────────

const mockEmitDeviceHeartbeat = vi.fn();
vi.mock("../server/deviceHeartbeat", () => ({
  emitDeviceHeartbeat: mockEmitDeviceHeartbeat,
}));

// ── Helper to build a mock tRPC context ───────────────────────────────────────

function makeCtx(role: "admin" | "user" = "admin") {
  return {
    user: { id: 1, openId: "test-open-id", name: "Test User", role },
    req: {} as never,
    res: {} as never,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Device QR Code Generation", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
    // QR HMAC secret fallback was removed (audit v13, P0-6): the router throws
    // PRECONDITION_FAILED when no signing secret is configured. Provide one.
    vi.stubEnv("NFC_MASTER_SECRET", "test-qr-signing-secret");
    vi.stubEnv("JWT_SECRET", "test-qr-signing-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("devices.getPlazaQrCode", () => {
    it("generates a signed QR URI for a known NFC reader", async () => {
      seedDevice({ serial: "NFC-LOS-001", plaza: "Lagos-Ibadan Toll", lane: "Lane 1" });
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("admin"));

      const result = await caller.getPlazaQrCode({ serial: "NFC-LOS-001" });

      expect(result.serial).toBe("NFC-LOS-001");
      expect(result.plaza).toBe("Lagos-Ibadan Toll");
      expect(result.lane).toBe("Lane 1");
      expect(result.qrUri).toMatch(/^nigerianpass:\/\/station\/NFC-LOS-001/);
      expect(result.qrUri).toContain("plaza=");
      expect(result.qrUri).toContain("lane=");
      expect(result.qrUri).toContain("ts=");
      expect(result.qrUri).toContain("sig=");
      expect(result.generatedAt).toBeTruthy();
    });

    it("QR URI contains a 16-character hex HMAC signature", async () => {
      seedDevice({ serial: "NFC-LOS-001" });
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("admin"));

      const result = await caller.getPlazaQrCode({ serial: "NFC-LOS-001" });

      const sigMatch = result.qrUri.match(/sig=([0-9a-f]+)/);
      expect(sigMatch).not.toBeNull();
      expect(sigMatch![1]).toHaveLength(16);
      expect(sigMatch![1]).toMatch(/^[0-9a-f]{16}$/);
    });

    it("QR URI encodes plaza name with URL encoding", async () => {
      seedDevice({ serial: "NFC-ABJ-001", plaza: "Abuja-Kaduna Toll", lane: "Lane 2" });
      // Override the mock to return the Abuja device
      const { getDb } = await import("../server/db");
      (getDb as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([Object.values(mockDevices)[0]]),
            }),
          }),
        }),
      });

      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("admin"));

      const result = await caller.getPlazaQrCode({ serial: "NFC-ABJ-001" });

      // Plaza name should be URL-encoded in the URI
      expect(result.qrUri).toContain("plaza=");
      expect(result.plaza).toBe("Abuja-Kaduna Toll");
    });

    it("rejects getPlazaQrCode by non-admin", async () => {
      seedDevice();
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("user"));

      await expect(caller.getPlazaQrCode({ serial: "NFC-LOS-001" }))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("throws NOT_FOUND when device serial does not exist", async () => {
      // Empty DB — no devices
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("admin"));

      await expect(caller.getPlazaQrCode({ serial: "NFC-UNKNOWN-999" }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("generatedAt is a valid ISO timestamp", async () => {
      seedDevice();
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("admin"));

      const before = new Date().toISOString();
      const result = await caller.getPlazaQrCode({ serial: "NFC-LOS-001" });
      const after = new Date().toISOString();

      expect(result.generatedAt >= before).toBe(true);
      expect(result.generatedAt <= after).toBe(true);
    });

    it("two calls produce different ts values (monotonically increasing)", async () => {
      seedDevice();
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("admin"));

      const r1 = await caller.getPlazaQrCode({ serial: "NFC-LOS-001" });
      await new Promise(r => setTimeout(r, 5));
      const r2 = await caller.getPlazaQrCode({ serial: "NFC-LOS-001" });

      const ts1 = parseInt(r1.qrUri.match(/ts=(\d+)/)![1]);
      const ts2 = parseInt(r2.qrUri.match(/ts=(\d+)/)![1]);
      expect(ts2).toBeGreaterThanOrEqual(ts1);
    });
  });

  describe("devices.simulateHeartbeat", () => {
    it("emits a heartbeat event for a known device", async () => {
      seedDevice({ serial: "NFC-LOS-001", plaza: "Lagos-Ibadan Toll" });
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("admin"));

      const result = await caller.simulateHeartbeat({
        serial: "NFC-LOS-001",
        status: "online",
        cpu: 45,
        memory: 60,
        temp: 38,
      });

      expect(result.success).toBe(true);
      expect(result.serial).toBe("NFC-LOS-001");
      expect(mockEmitDeviceHeartbeat).toHaveBeenCalledOnce();
    });

    it("heartbeat event contains correct telemetry fields", async () => {
      seedDevice({ serial: "NFC-LOS-001" });
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("admin"));

      await caller.simulateHeartbeat({
        serial: "NFC-LOS-001",
        status: "warning",
        cpu: 75,
        memory: 82,
        temp: 65,
      });

      const call = mockEmitDeviceHeartbeat.mock.calls[0][0];
      expect(call.serial).toBe("NFC-LOS-001");
      expect(call.status).toBe("warning");
      expect(call.cpu_percent).toBe(75);
      expect(call.memory_percent).toBe(82);
      expect(call.temperature_celsius).toBe(65);
      expect(call.timestamp).toBeTruthy();
    });

    it("rejects simulateHeartbeat by non-admin", async () => {
      seedDevice();
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("user"));

      await expect(caller.simulateHeartbeat({
        serial: "NFC-LOS-001",
        status: "online",
        cpu: 45,
        memory: 60,
        temp: 38,
      })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("throws NOT_FOUND for unknown serial", async () => {
      // Empty DB
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("admin"));

      await expect(caller.simulateHeartbeat({
        serial: "NFC-GHOST-000",
        status: "online",
        cpu: 10,
        memory: 20,
        temp: 30,
      })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("uses default values when optional fields omitted", async () => {
      seedDevice({ serial: "NFC-LOS-001" });
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("admin"));

      // Only serial is required; status/cpu/memory/temp have defaults
      const result = await caller.simulateHeartbeat({ serial: "NFC-LOS-001" });
      expect(result.success).toBe(true);

      const call = mockEmitDeviceHeartbeat.mock.calls[0][0];
      expect(call.status).toBe("online");   // default
      expect(call.cpu_percent).toBe(45);    // default
      expect(call.memory_percent).toBe(60); // default
      expect(call.temperature_celsius).toBe(38); // default
    });
  });
});
