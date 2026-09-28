/**
 * Device CRUD Router Tests
 * ========================
 * Verifies the full CRUD lifecycle for the toll_devices table:
 *  - create, list, get, update, delete, updateHeartbeat, plazaSummary
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
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

// ── Mock the DB module ─────────────────────────────────────────────────────────

vi.mock("../server/db", () => ({
  getDb: vi.fn().mockResolvedValue({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => Promise.resolve(Object.values(mockDevices)),
          limit: () => Promise.resolve(Object.values(mockDevices).slice(0, 1)),
        }),
        orderBy: () => Promise.resolve(Object.values(mockDevices)),
        groupBy: () => ({
          orderBy: () => Promise.resolve(
            Object.values(mockDevices).reduce((acc, d) => {
              const p = acc.find(x => x.plaza === d.plaza);
              if (p) {
                p.total++;
                if (d.status === "online") p.online++;
                if (d.status === "warning") p.warning++;
                if (d.status === "offline") p.offline++;
                if (d.status === "maintenance") p.maintenance++;
              } else {
                acc.push({
                  plaza: d.plaza, total: 1,
                  online: d.status === "online" ? 1 : 0,
                  warning: d.status === "warning" ? 1 : 0,
                  offline: d.status === "offline" ? 1 : 0,
                  maintenance: d.status === "maintenance" ? 1 : 0,
                });
              }
              return acc;
            }, [] as { plaza: string; total: number; online: number; warning: number; offline: number; maintenance: number }[])
          ),
        }),
      }),
    }),
    insert: () => ({
      values: (data: Record<string, unknown>) => ({
        returning: () => {
          const serial = data.serial as string;
          const existing = Object.values(mockDevices).find(d => d.serial === serial);
          if (existing) throw new Error("unique constraint violated");
          const id = nextId++;
          const now = new Date();
          mockDevices[id] = {
            id, serial, name: data.name as string,
            type: data.type as string, plaza: data.plaza as string,
            lane: data.lane as string, status: (data.status as string) ?? "offline",
            firmware: (data.firmware as string) ?? "1.0.0",
            latestFirmware: (data.latestFirmware as string) ?? "1.0.0",
            uptime: "0d 0h", cpu: 0, memory: 0, temp: 0, alerts: 0,
            lastSeen: now, createdAt: now, updatedAt: now,
          };
          return Promise.resolve([mockDevices[id]]);
        },
      }),
    }),
    update: () => ({
      set: (data: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            const entries = Object.entries(mockDevices);
            if (entries.length === 0) return Promise.resolve([]);
            const [idStr, device] = entries[entries.length - 1];
            const id = parseInt(idStr);
            mockDevices[id] = { ...device, ...data, updatedAt: new Date() } as typeof device;
            return Promise.resolve([mockDevices[id]]);
          },
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: () => {
          const entries = Object.entries(mockDevices);
          if (entries.length === 0) return Promise.resolve([]);
          const [idStr, device] = entries[entries.length - 1];
          const id = parseInt(idStr);
          const deleted = { id: device.id, serial: device.serial };
          delete mockDevices[id];
          return Promise.resolve([deleted]);
        },
      }),
    }),
  }),
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

describe("Device CRUD Router", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
  });

  // ── Create ─────────────────────────────────────────────────────────────────

  describe("devices.create", () => {
    it("creates a device when admin", async () => {
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("admin"));

      const result = await caller.create({
        serial: "NFC-LOS-001",
        name: "NFC Reader — Lane 1",
        type: "nfc_reader",
        plaza: "Lagos-Ibadan Toll",
        lane: "Lane 1",
        firmware: "2.4.1",
        latestFirmware: "2.4.1",
      });

      expect(result.serial).toBe("NFC-LOS-001");
      expect(result.type).toBe("nfc_reader");
      expect(result.plaza).toBe("Lagos-Ibadan Toll");
    });

    it("rejects creation by non-admin", async () => {
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("user"));

      await expect(caller.create({
        serial: "NFC-LOS-002",
        name: "NFC Reader",
        type: "nfc_reader",
        plaza: "Lagos-Ibadan Toll",
        lane: "Lane 2",
        firmware: "2.4.1",
        latestFirmware: "2.4.1",
      })).rejects.toThrow(TRPCError);
    });

    it("rejects duplicate serial numbers", async () => {
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("admin"));

      await caller.create({
        serial: "NFC-LOS-001",
        name: "NFC Reader",
        type: "nfc_reader",
        plaza: "Lagos-Ibadan Toll",
        lane: "Lane 1",
        firmware: "2.4.1",
        latestFirmware: "2.4.1",
      });

      await expect(caller.create({
        serial: "NFC-LOS-001",
        name: "Duplicate Device",
        type: "nfc_reader",
        plaza: "Lagos-Ibadan Toll",
        lane: "Lane 2",
        firmware: "2.4.1",
        latestFirmware: "2.4.1",
      })).rejects.toThrow(TRPCError);
    });
  });

  // ── List ───────────────────────────────────────────────────────────────────

  describe("devices.list", () => {
    it("returns all devices for authenticated users", async () => {
      const { devicesRouter } = await import("../server/routers/devices");
      const adminCaller = devicesRouter.createCaller(makeCtx("admin"));
      await adminCaller.create({
        serial: "BAR-LOS-001", name: "Boom Barrier", type: "barrier",
        plaza: "Lagos-Ibadan Toll", lane: "Lane 1",
        firmware: "1.8.3", latestFirmware: "1.9.0",
      });

      const userCaller = devicesRouter.createCaller(makeCtx("user"));
      const result = await userCaller.list();
      expect(result.total).toBeGreaterThanOrEqual(1);
      expect(result.source).toBe("live");
    });

    it("returns empty list when no devices exist", async () => {
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("user"));
      const result = await caller.list();
      expect(result.devices).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  // ── Update ─────────────────────────────────────────────────────────────────

  describe("devices.update", () => {
    it("updates device status when admin", async () => {
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("admin"));

      const created = await caller.create({
        serial: "CAM-LOS-001", name: "ANPR Camera", type: "camera",
        plaza: "Lagos-Ibadan Toll", lane: "Lane 1",
        firmware: "3.1.0", latestFirmware: "3.2.1",
      });

      const updated = await caller.update({
        id: created.id,
        data: { status: "warning", firmware: "3.2.1" },
      });

      expect(updated.status).toBe("warning");
      expect(updated.firmware).toBe("3.2.1");
    });

    it("rejects update by non-admin", async () => {
      const { devicesRouter } = await import("../server/routers/devices");
      const adminCaller = devicesRouter.createCaller(makeCtx("admin"));
      const created = await adminCaller.create({
        serial: "CAM-LOS-002", name: "ANPR Camera 2", type: "camera",
        plaza: "Lagos-Ibadan Toll", lane: "Lane 2",
        firmware: "3.1.0", latestFirmware: "3.2.1",
      });

      const userCaller = devicesRouter.createCaller(makeCtx("user"));
      await expect(userCaller.update({
        id: created.id,
        data: { status: "offline" },
      })).rejects.toThrow(TRPCError);
    });
  });

  // ── Delete ─────────────────────────────────────────────────────────────────

  describe("devices.delete", () => {
    it("deletes a device when admin", async () => {
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("admin"));

      const created = await caller.create({
        serial: "EDG-LOS-001", name: "Edge Unit", type: "edge_unit",
        plaza: "Lagos-Ibadan Toll", lane: "All Lanes",
        firmware: "5.0.2", latestFirmware: "5.0.2",
      });

      const result = await caller.delete({ id: created.id });
      expect(result.success).toBe(true);
      expect(result.deleted.serial).toBe("EDG-LOS-001");
    });

    it("rejects delete by non-admin", async () => {
      const { devicesRouter } = await import("../server/routers/devices");
      const adminCaller = devicesRouter.createCaller(makeCtx("admin"));
      const created = await adminCaller.create({
        serial: "EDG-ABJ-001", name: "Edge Unit 2", type: "edge_unit",
        plaza: "Abuja-Kaduna Toll", lane: "All Lanes",
        firmware: "5.0.2", latestFirmware: "5.0.2",
      });

      const userCaller = devicesRouter.createCaller(makeCtx("user"));
      await expect(userCaller.delete({ id: created.id })).rejects.toThrow(TRPCError);
    });
  });

  // ── updateHeartbeat ────────────────────────────────────────────────────────

  describe("devices.updateHeartbeat", () => {
    it("updates telemetry fields via heartbeat (admin only)", async () => {
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("admin"));

      await caller.create({
        serial: "NFC-HB-001", name: "Heartbeat Test Device", type: "nfc_reader",
        plaza: "Test Plaza", lane: "Lane 1",
        firmware: "2.4.1", latestFirmware: "2.4.1",
      });

      const result = await caller.updateHeartbeat({
        serial: "NFC-HB-001",
        status: "online",
        cpu: 42.7,
        memory: 61.3,
        temp: 48.5,
        uptime: "3d 14h",
      });

      expect(result.success).toBe(true);
    });

    it("rejects heartbeat update by non-admin", async () => {
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("user"));

      await expect(caller.updateHeartbeat({
        serial: "NFC-HB-001",
        status: "online",
      })).rejects.toThrow(TRPCError);
    });
  });

  // ── plazaSummary ───────────────────────────────────────────────────────────

  describe("devices.plazaSummary", () => {
    it("returns aggregated counts per plaza", async () => {
      const { devicesRouter } = await import("../server/routers/devices");
      const caller = devicesRouter.createCaller(makeCtx("admin"));

      await caller.create({
        serial: "NFC-PS-001", name: "NFC Reader 1", type: "nfc_reader",
        plaza: "Lagos-Ibadan Toll", lane: "Lane 1",
        firmware: "2.4.1", latestFirmware: "2.4.1", status: "online",
      });
      await caller.create({
        serial: "BAR-PS-001", name: "Barrier 1", type: "barrier",
        plaza: "Lagos-Ibadan Toll", lane: "Lane 1",
        firmware: "1.8.3", latestFirmware: "1.9.0", status: "warning",
      });

      const userCaller = devicesRouter.createCaller(makeCtx("user"));
      const summary = await userCaller.plazaSummary();
      expect(summary.length).toBeGreaterThanOrEqual(1);
      const lagosSummary = summary.find(s => s.plaza === "Lagos-Ibadan Toll");
      expect(lagosSummary).toBeDefined();
      expect(lagosSummary!.total).toBeGreaterThanOrEqual(2);
    });
  });
});
