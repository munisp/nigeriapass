/**
 * USSD + Devices v16 Feature Tests
 * ==================================
 * Verifies:
 *  - ussd.getSessionDetail — admin-only, parses menu path into steps, computes durationMs
 *  - ussd.getSessionList   — admin-only, filters by completed/phone/days, returns sessions
 *  - devices.getFirmwareMatrix — groups devices by firmware version, marks isLatest
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Mock DB state ─────────────────────────────────────────────────────────────

type MockSession = {
  id: number;
  sessionId: string;
  phoneNumber: string;
  serviceCode: string;
  completed: boolean;
  interactionCount: number;
  menuPath: string | null;
  durationSeconds: number | null;
  startedAt: Date;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type MockDevice = {
  id: number; serial: string; name: string; type: string;
  plaza: string; lane: string; status: string; firmware: string;
  latestFirmware: string; uptime: string; cpu: number; memory: number;
  temp: number; alerts: number; lastSeen: Date; createdAt: Date; updatedAt: Date;
};

let mockSessions: MockSession[] = [];
let mockDevices: MockDevice[] = [];

function resetDb() {
  mockSessions = [];
  mockDevices = [];
}

function seedSession(overrides: Partial<MockSession> = {}): MockSession {
  const id = mockSessions.length + 1;
  const now = new Date();
  const s: MockSession = {
    id,
    sessionId: `AT-SESSION-${id}`,
    phoneNumber: `+23480000000${id}`,
    serviceCode: "*346#",
    completed: true,
    interactionCount: 3,
    menuPath: "1|3|0",
    durationSeconds: 42,
    startedAt: new Date(now.getTime() - 60_000),
    endedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  mockSessions.push(s);
  return s;
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

// ── Mock the DB module ─────────────────────────────────────────────────────────

const mockSelect = vi.fn();
const mockUpdate = vi.fn();
const mockInsert = vi.fn();

vi.mock("../server/db", () => ({
  getDb: vi.fn().mockImplementation(() =>
    Promise.resolve({ select: mockSelect, update: mockUpdate, insert: mockInsert })
  ),
}));

vi.mock("../server/deviceHeartbeat", () => ({
  emitDeviceHeartbeat: vi.fn(),
}));

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

// ── ussd.getSessionDetail tests ───────────────────────────────────────────────

describe("ussd.getSessionDetail", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
  });

  it("returns session with parsed menu steps", async () => {
    const session = seedSession({ menuPath: "1|3|0", durationSeconds: 42 });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([session]),
        }),
      }),
    });

    const { ussdRouter } = await import("../server/routers/ussd");
    const caller = ussdRouter.createCaller(makeCtx("admin"));

    const result = await caller.getSessionDetail({ sessionId: session.sessionId });

    expect(result.session.sessionId).toBe(session.sessionId);
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]).toMatchObject({ step: 1, input: "1", label: "Check Balance" });
    expect(result.steps[1]).toMatchObject({ step: 2, input: "3", label: "Mini Statement" });
    expect(result.steps[2]).toMatchObject({ step: 3, input: "0", label: "Back / Exit" });
  });

  it("computes durationMs from durationSeconds when available", async () => {
    const session = seedSession({ durationSeconds: 60 });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([session]),
        }),
      }),
    });

    const { ussdRouter } = await import("../server/routers/ussd");
    const caller = ussdRouter.createCaller(makeCtx("admin"));

    const result = await caller.getSessionDetail({ sessionId: session.sessionId });

    expect(result.durationMs).toBe(60_000);
  });

  it("computes durationMs from startedAt/endedAt when durationSeconds is null", async () => {
    const startedAt = new Date("2026-01-01T10:00:00Z");
    const endedAt = new Date("2026-01-01T10:00:30Z");
    const session = seedSession({ durationSeconds: null, startedAt, endedAt });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([session]),
        }),
      }),
    });

    const { ussdRouter } = await import("../server/routers/ussd");
    const caller = ussdRouter.createCaller(makeCtx("admin"));

    const result = await caller.getSessionDetail({ sessionId: session.sessionId });

    expect(result.durationMs).toBe(30_000);
  });

  it("returns empty steps array when menuPath is null", async () => {
    const session = seedSession({ menuPath: null });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([session]),
        }),
      }),
    });

    const { ussdRouter } = await import("../server/routers/ussd");
    const caller = ussdRouter.createCaller(makeCtx("admin"));

    const result = await caller.getSessionDetail({ sessionId: session.sessionId });

    expect(result.steps).toHaveLength(0);
    expect(result.durationMs).not.toBeNull();
  });

  it("throws NOT_FOUND when session does not exist", async () => {
    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    });

    const { ussdRouter } = await import("../server/routers/ussd");
    const caller = ussdRouter.createCaller(makeCtx("admin"));

    await expect(caller.getSessionDetail({ sessionId: "NONEXISTENT" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("throws FORBIDDEN for non-admin user", async () => {
    const { ussdRouter } = await import("../server/routers/ussd");
    const caller = ussdRouter.createCaller(makeCtx("user"));

    await expect(caller.getSessionDetail({ sessionId: "ANY" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("returns correct summary fields", async () => {
    const session = seedSession({
      phoneNumber: "+2348012345678",
      serviceCode: "*346#",
      completed: true,
      interactionCount: 5,
    });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([session]),
        }),
      }),
    });

    const { ussdRouter } = await import("../server/routers/ussd");
    const caller = ussdRouter.createCaller(makeCtx("admin"));

    const result = await caller.getSessionDetail({ sessionId: session.sessionId });

    expect(result.summary.phone).toBe("+2348012345678");
    expect(result.summary.completed).toBe(true);
    expect(result.summary.interactionCount).toBe(5);
    expect(result.summary.serviceCode).toBe("*346#");
  });
});

// ── ussd.getSessionList tests ─────────────────────────────────────────────────

describe("ussd.getSessionList", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
  });

  it("returns sessions list with correct total count", async () => {
    const s1 = seedSession({ completed: true });
    const s2 = seedSession({ completed: false });
    const s3 = seedSession({ completed: true });

    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              offset: () => Promise.resolve([s1, s2, s3]),
            }),
          }),
        }),
      }),
    });

    const { ussdRouter } = await import("../server/routers/ussd");
    const caller = ussdRouter.createCaller(makeCtx("admin"));

    const result = await caller.getSessionList({ days: 30, limit: 50, offset: 0 });

    expect(result.sessions).toHaveLength(3);
    expect(result.total).toBe(3);
  });

  it("returns empty list when no sessions exist", async () => {
    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              offset: () => Promise.resolve([]),
            }),
          }),
        }),
      }),
    });

    const { ussdRouter } = await import("../server/routers/ussd");
    const caller = ussdRouter.createCaller(makeCtx("admin"));

    const result = await caller.getSessionList({});

    expect(result.sessions).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("throws FORBIDDEN for non-admin user", async () => {
    const { ussdRouter } = await import("../server/routers/ussd");
    const caller = ussdRouter.createCaller(makeCtx("user"));

    await expect(caller.getSessionList({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("accepts pagination parameters without error", async () => {
    mockSelect.mockReturnValue({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              offset: () => Promise.resolve([]),
            }),
          }),
        }),
      }),
    });

    const { ussdRouter } = await import("../server/routers/ussd");
    const caller = ussdRouter.createCaller(makeCtx("admin"));

    const result = await caller.getSessionList({ limit: 10, offset: 20, days: 7 });

    expect(result.sessions).toHaveLength(0);
  });
});

// ── devices.getFirmwareMatrix tests ──────────────────────────────────────────

describe("devices.getFirmwareMatrix", () => {
  beforeEach(() => {
    resetDb();
    vi.clearAllMocks();
  });

  it("groups devices by firmware version with correct counts", async () => {
    const d1 = seedDevice({ firmware: "2.4.2", latestFirmware: "2.4.2", plaza: "Plaza A" });
    const d2 = seedDevice({ firmware: "2.4.1", latestFirmware: "2.4.2", plaza: "Plaza B" });
    const d3 = seedDevice({ firmware: "2.4.1", latestFirmware: "2.4.2", plaza: "Plaza C" });

    mockSelect.mockReturnValue({
      from: () => Promise.resolve([
        { firmware: d1.firmware, latestFirmware: d1.latestFirmware, plaza: d1.plaza },
        { firmware: d2.firmware, latestFirmware: d2.latestFirmware, plaza: d2.plaza },
        { firmware: d3.firmware, latestFirmware: d3.latestFirmware, plaza: d3.plaza },
      ]),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.getFirmwareMatrix();

    expect(result).toHaveLength(2);
    const latest = result.find(r => r.version === "2.4.2");
    const outdated = result.find(r => r.version === "2.4.1");
    expect(latest).toBeDefined();
    expect(latest?.deviceCount).toBe(1);
    expect(latest?.isLatest).toBe(true);
    expect(outdated?.deviceCount).toBe(2);
    expect(outdated?.isLatest).toBe(false);
  });

  it("marks the most common latestFirmware as the target version", async () => {
    // 3 devices targeting 2.5.0, 1 device targeting 2.4.2 (legacy)
    mockSelect.mockReturnValue({
      from: () => Promise.resolve([
        { firmware: "2.5.0", latestFirmware: "2.5.0", plaza: "A" },
        { firmware: "2.4.2", latestFirmware: "2.5.0", plaza: "B" },
        { firmware: "2.4.2", latestFirmware: "2.5.0", plaza: "C" },
        { firmware: "2.4.2", latestFirmware: "2.4.2", plaza: "D" },
      ]),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.getFirmwareMatrix();

    // "2.5.0" appears 3 times as latestFirmware → it's the target
    const latest = result.find(r => r.version === "2.5.0");
    expect(latest?.isLatest).toBe(true);
  });

  it("returns empty array when no devices exist", async () => {
    mockSelect.mockReturnValue({
      from: () => Promise.resolve([]),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.getFirmwareMatrix();

    expect(result).toHaveLength(0);
  });

  it("collects unique plaza names per version", async () => {
    mockSelect.mockReturnValue({
      from: () => Promise.resolve([
        { firmware: "2.4.1", latestFirmware: "2.4.2", plaza: "Plaza A" },
        { firmware: "2.4.1", latestFirmware: "2.4.2", plaza: "Plaza A" }, // duplicate plaza
        { firmware: "2.4.1", latestFirmware: "2.4.2", plaza: "Plaza B" },
      ]),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.getFirmwareMatrix();

    expect(result).toHaveLength(1);
    expect(result[0].plazas).toHaveLength(2); // Plaza A and Plaza B (deduplicated)
    expect(result[0].plazas).toContain("Plaza A");
    expect(result[0].plazas).toContain("Plaza B");
  });

  it("sorts latest version first, then by device count descending", async () => {
    mockSelect.mockReturnValue({
      from: () => Promise.resolve([
        { firmware: "2.4.1", latestFirmware: "2.4.2", plaza: "A" },
        { firmware: "2.4.1", latestFirmware: "2.4.2", plaza: "B" },
        { firmware: "2.3.0", latestFirmware: "2.4.2", plaza: "C" },
        { firmware: "2.4.2", latestFirmware: "2.4.2", plaza: "D" },
      ]),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.getFirmwareMatrix();

    // Latest version (2.4.2) should come first
    expect(result[0].version).toBe("2.4.2");
    expect(result[0].isLatest).toBe(true);
    // Then by count: 2.4.1 (2 devices) before 2.3.0 (1 device)
    expect(result[1].version).toBe("2.4.1");
    expect(result[2].version).toBe("2.3.0");
  });

  it("returns empty array on DB error (graceful fallback)", async () => {
    mockSelect.mockReturnValue({
      from: () => Promise.reject(new Error("DB connection failed")),
    });

    const { devicesRouter } = await import("../server/routers/devices");
    const caller = devicesRouter.createCaller(makeCtx("admin"));

    const result = await caller.getFirmwareMatrix();

    expect(result).toHaveLength(0);
  });
});
