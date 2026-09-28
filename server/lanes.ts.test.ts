/**
 * RFID Lane Middleware Tests (server/routers/lanes.ts)
 * ====================================================
 * Covers the full lane pipeline: idempotency on eventUid, tag resolution,
 * anti-passback, atomic charging with insufficient-funds handling, free entry
 * reads, batch store-and-forward isolation, lane HMAC auth, and the operator
 * read endpoints (recentEvents / laneSummary / tagHistory).
 *
 * All DB access runs against an in-memory fake drizzle implementation;
 * debitWalletAtomic is re-implemented over the same in-memory wallet store
 * (same semantics: conditional decrement, idempotency key, daily cap).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac, randomUUID } from "crypto";
import { rfidTags, laneEvents, walletAccounts, auditLogs } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

// ── In-memory store ───────────────────────────────────────────────────────────

type MockRow = Record<string, any>;

const mockState = {
  tags: [] as MockRow[],
  events: [] as MockRow[],
  wallets: [] as MockRow[],
  audits: [] as MockRow[],
  walletTxns: [] as MockRow[],
  seenRefs: new Set<string>(),
  seq: { tag: 1, event: 1, audit: 1, txn: 1 },
};

function mockReset() {
  mockState.tags = [];
  mockState.events = [];
  mockState.wallets = [];
  mockState.audits = [];
  mockState.walletTxns = [];
  mockState.seenRefs = new Set();
  mockState.seq = { tag: 1, event: 1, audit: 1, txn: 1 };
}

function mockSeedWallet(overrides: Partial<MockRow> = {}) {
  const id = overrides.id ?? mockState.wallets.length + 1;
  const row: MockRow = {
    id,
    userId: id * 100,
    tigerBeetleId: `TB-${id}`,
    balanceKobo: 1_000_000,
    dailyCapKobo: 500_000,
    dailySpentKobo: 0,
    lastBalanceSync: new Date(),
    createdAt: new Date(Date.now() - 30 * 86_400_000),
    updatedAt: new Date(),
    ...overrides,
  };
  mockState.wallets.push(row);
  return row;
}

function mockSeedTag(overrides: Partial<MockRow> = {}) {
  const row: MockRow = {
    id: mockState.seq.tag++,
    tagEpc: "AAAA0000000000000000000A",
    tagType: "rfid_windshield",
    vehiclePlate: "LAG-123-XY",
    kycApplicationId: null,
    walletId: null,
    status: "active",
    issuedBy: 1,
    issuedAt: new Date(),
    activatedAt: new Date(),
    replacedByTagId: null,
    meta: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  mockState.tags.push(row);
  return row;
}

// ── Mini drizzle-SQL evaluator (same subset as the etag tests) ───────────────

function mockTokens(expr: any): any[] {
  const out: any[] = [];
  for (const c of expr?.queryChunks ?? []) {
    const n = c?.constructor?.name;
    if (n === "StringChunk") {
      out.push({ t: "str", v: Array.isArray(c.value) ? c.value.join("") : String(c.value) });
    } else if (n === "SQL") out.push({ t: "sql", v: c });
    else if (n === "Param") out.push({ t: "val", v: c.value });
    else if (typeof c === "string" || c instanceof String) out.push({ t: "val", v: String(c) });
    else if (Array.isArray(c)) out.push({ t: "val", v: c.map((x: any) => (x && typeof x === "object" && "value" in x ? x.value : x)) });
    else if (typeof c === "number") out.push({ t: "val", v: c });
    else if (c && typeof c === "object" && "name" in c && "table" in c) out.push({ t: "col", v: c.name });
    else out.push({ t: "val", v: c });
  }
  return out;
}

function mockNorm(v: any) {
  return v instanceof Date ? v.getTime() : v;
}

function mockEvalToks(toks: any[], row: MockRow): boolean {
  if (toks.length === 0) return true;
  if (toks.length === 1 && toks[0].t === "sql") return mockEvalCond(toks[0].v, row);
  const opi = toks.findIndex(
    (t) => t.t === "str" && /(=|>=|<=|>|<|ilike|like|\bin\b|->>)/i.test(t.v),
  );
  if (opi < 0) throw new Error(`mock: unsupported tokens ${JSON.stringify(toks)}`);
  const op = toks[opi].v.trim().toLowerCase();
  const colTok = toks[opi - 1];
  const valTok = toks[opi + 1];

  if (op.includes("->>")) {
    const key = op.match(/->>\s*'([^']+)'/)?.[1];
    return String(row[colTok.v]?.[key ?? ""] ?? "") === String(valTok?.v);
  }

  const left = row[colTok.v];
  const right = valTok?.v;

  if (op === "in") return Array.isArray(right) && right.includes(left);
  if (op === "ilike" || op === "like") {
    const pat = String(right).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*");
    return new RegExp(`^${pat}$`).test(String(left ?? "").toLowerCase());
  }
  const a = mockNorm(left);
  const b = mockNorm(right);
  switch (op) {
    case "=": return a === b;
    case ">=": return a >= b;
    case "<=": return a <= b;
    case ">": return a > b;
    case "<": return a < b;
    default: throw new Error(`mock: unsupported op "${op}"`);
  }
}

function mockEvalCond(expr: any, row: MockRow): boolean {
  if (!expr) return true;
  let toks = mockTokens(expr).filter((t) => !(t.t === "str" && t.v.trim() === ""));
  if (
    toks.length >= 2 &&
    toks[0].t === "str" && toks[0].v.trim() === "(" &&
    toks[toks.length - 1].t === "str" && toks[toks.length - 1].v.trim() === ")"
  ) {
    toks = toks.slice(1, -1);
  }
  const parts: any[][] = [[]];
  const ops: string[] = [];
  for (const tk of toks) {
    if (tk.t === "str" && /^\s*(and|or)\s*$/i.test(tk.v)) {
      ops.push(tk.v.trim().toLowerCase());
      parts.push([]);
    } else {
      parts[parts.length - 1].push(tk);
    }
  }
  let acc = mockEvalToks(parts[0], row);
  for (let i = 0; i < ops.length; i++) {
    const r = mockEvalToks(parts[i + 1], row);
    acc = ops[i] === "and" ? acc && r : acc || r;
  }
  return acc;
}

function mockRowsFor(table: any): MockRow[] {
  if (table === rfidTags) return mockState.tags;
  if (table === laneEvents) return mockState.events;
  if (table === walletAccounts) return mockState.wallets;
  if (table === auditLogs) return mockState.audits;
  throw new Error("mock: unknown table");
}

function mockSort(rows: MockRow[], orders: any[]) {
  for (const o of [...orders].reverse()) {
    const toks = mockTokens(o).filter((t) => !(t.t === "str" && t.v.trim() === ""));
    const col = toks.find((t) => t.t === "col")?.v;
    const dir = toks.some((t) => t.t === "str" && /desc/i.test(t.v)) ? -1 : 1;
    if (!col) continue;
    rows.sort((a, b) => {
      const x = mockNorm(a[col]);
      const y = mockNorm(b[col]);
      return x < y ? -dir : x > y ? dir : 0;
    });
  }
}

function mockSelect(fields?: Record<string, any>) {
  const q: any = { table: null, cond: undefined, orders: [], lim: undefined, off: 0 };
  const exec = () => {
    let rows = mockRowsFor(q.table).filter((r) => mockEvalCond(q.cond, r));
    mockSort(rows, q.orders);
    if (q.off) rows = rows.slice(q.off);
    if (q.lim != null) rows = rows.slice(0, q.lim);
    if (fields) {
      return rows.map((r) => {
        const o: MockRow = {};
        for (const k of Object.keys(fields)) {
          const f = fields[k];
          o[k] = f && typeof f === "object" && "name" in f ? r[f.name] : r[k];
        }
        return o;
      });
    }
    return rows;
  };
  const b: any = {
    from(t: any) { q.table = t; return b; },
    where(c: any) { q.cond = c; return b; },
    orderBy(...o: any[]) { q.orders = o; return b; },
    limit(n: number) { q.lim = n; return b; },
    offset(n: number) { q.off = n; return b; },
    groupBy() { return b; },
    then(res: any, rej: any) { return Promise.resolve().then(exec).then(res, rej); },
  };
  return b;
}

function mockInsert(table: any, values: MockRow) {
  let ignoreConflict = false;
  const run = () => {
    if (table === laneEvents) {
      if (mockState.events.some((e) => e.eventUid === values.eventUid)) {
        if (ignoreConflict) return [];
        const e = new Error("duplicate key value violates unique constraint") as any;
        e.code = "23505";
        throw e;
      }
      const row: MockRow = {
        id: mockState.seq.event++,
        antiPassbackBlocked: false,
        receivedAt: new Date(),
        ...values,
      };
      mockState.events.push(row);
      return [row];
    }
    if (table === rfidTags) {
      const row: MockRow = { id: mockState.seq.tag++, createdAt: new Date(), updatedAt: new Date(), ...values };
      mockState.tags.push(row);
      return [row];
    }
    if (table === auditLogs) {
      const row: MockRow = { id: mockState.seq.audit++, createdAt: new Date(), ...values };
      mockState.audits.push(row);
      return [row];
    }
    throw new Error("mock insert: unknown table");
  };
  const r: any = {
    onConflictDoNothing() { ignoreConflict = true; return r; },
    returning() { return Promise.resolve().then(run); },
    then(res: any, rej: any) { return Promise.resolve().then(run).then(res, rej); },
  };
  return r;
}

function mockUpdate(table: any, set: MockRow) {
  return {
    where(cond: any) {
      const exec = () => {
        const matched = mockRowsFor(table).filter((r) => mockEvalCond(cond, r));
        for (const r of matched) Object.assign(r, set);
        return matched;
      };
      const w: any = {
        returning() { return Promise.resolve().then(exec); },
        then(res: any, rej: any) { return Promise.resolve().then(exec).then(res, rej); },
      };
      return w;
    },
  };
}

const mockDb: any = {
  select: (fields?: Record<string, any>) => mockSelect(fields),
  insert: (table: any) => ({ values: (v: MockRow) => mockInsert(table, v) }),
  update: (table: any) => ({ set: (s: MockRow) => mockUpdate(table, s) }),
  transaction: (cb: (tx: any) => Promise<any>) => cb(mockDb),
};

// ── Mock the DB module (getDb + atomic debit over the in-memory store) ───────

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    ...actual,
    getDb: vi.fn(async () => mockDb),
    // Same semantics as the real debitWalletAtomic: conditional decrement,
    // idempotency on externalRef, daily cap, balance never negative.
    debitWalletAtomic: vi.fn(async (params: {
      userId: number;
      amountKobo: number;
      externalRef: string;
      description: string;
      plazaId?: string;
    }) => {
      const wallet = mockState.wallets.find((w) => w.userId === params.userId);
      if (!wallet) return { status: "no_wallet" } as const;
      if (mockState.seenRefs.has(params.externalRef)) return { status: "duplicate" } as const;
      if (wallet.dailySpentKobo + params.amountKobo > wallet.dailyCapKobo) {
        return {
          status: "daily_cap_exceeded",
          dailyCapKobo: wallet.dailyCapKobo,
          dailySpentKobo: wallet.dailySpentKobo,
        } as const;
      }
      if (wallet.balanceKobo < params.amountKobo) {
        return { status: "insufficient_funds", balanceKobo: wallet.balanceKobo } as const;
      }
      mockState.seenRefs.add(params.externalRef);
      wallet.balanceKobo -= params.amountKobo;
      wallet.dailySpentKobo += params.amountKobo;
      const txn = {
        id: mockState.seq.txn++,
        walletId: wallet.id,
        type: "toll_charge",
        amountKobo: params.amountKobo,
        balanceAfterKobo: wallet.balanceKobo,
        externalRef: params.externalRef,
        plazaId: params.plazaId ?? null,
        description: params.description,
        createdAt: new Date(),
      };
      mockState.walletTxns.push(txn);
      return {
        status: "debited",
        walletId: wallet.id,
        transactionId: txn.id,
        newBalanceKobo: wallet.balanceKobo,
      } as const;
    }),
  };
});

// ── Router under test ─────────────────────────────────────────────────────────

import { lanesRouter, PLAZA_TARIFFS_KOBO } from "./routers/lanes";

const LANE_SECRET = "test-lane-hmac-secret";
const READER_ID = "reader-lag-01";
const EPC = "AAAA0000000000000000000A";
const EPC_2 = "BBBB0000000000000000000B";

function laneToken(readerId = READER_ID): string {
  return createHmac("sha256", LANE_SECRET).update(`lane:${readerId}`).digest("hex");
}

function makeLaneCtx(token?: string): TrpcContext {
  return {
    user: null,
    req: { headers: token ? { "x-lane-token": token } : {} } as never,
    res: {} as never,
  };
}

function makeUserCtx(role: string, userId = 1): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `user:${userId}`,
      name: `User ${userId}`,
      email: null,
      role,
      loginMethod: "oauth",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as any,
    req: { headers: {} } as never,
    res: {} as never,
  };
}

function laneInput(overrides: Partial<Record<string, any>> = {}) {
  return {
    eventUid: randomUUID(),
    plazaId: "lagos-ibadan",
    laneId: "lane-1",
    readerId: READER_ID,
    tagEpc: EPC,
    direction: "exit",
    occurredAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  mockReset();
  vi.stubEnv("LANE_HMAC_SECRET", LANE_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── Lane-controller authentication ────────────────────────────────────────────

describe("lane HMAC auth", () => {
  it("rejects requests without an x-lane-token", async () => {
    const caller = lanesRouter.createCaller(makeLaneCtx());
    await expect(caller.ingestEvent(laneInput()))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a token signed for a different readerId", async () => {
    const caller = lanesRouter.createCaller(makeLaneCtx(laneToken("other-reader")));
    await expect(caller.ingestEvent(laneInput()))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("fails closed when no lane secret is configured", async () => {
    vi.stubEnv("LANE_HMAC_SECRET", "");
    // NFC_MASTER_SECRET is unset in the test environment, so no fallback exists.
    const caller = lanesRouter.createCaller(makeLaneCtx(laneToken()));
    await expect(caller.ingestEvent(laneInput()))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

// ── Charging pipeline ─────────────────────────────────────────────────────────

describe("lanes.ingestEvent pipeline", () => {
  it("charges an active tag at the plaza tariff and records the event", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    mockSeedTag({ tagEpc: EPC, walletId: wallet.id });

    const caller = lanesRouter.createCaller(makeLaneCtx(laneToken()));
    const result = await caller.ingestEvent(laneInput());

    expect(result.chargeStatus).toBe("charged");
    expect(result.duplicate).toBe(false);
    expect(result.amountKobo).toBe(PLAZA_TARIFFS_KOBO["lagos-ibadan"]);
    expect(result.balanceAfter).toBe(1_000_000 - PLAZA_TARIFFS_KOBO["lagos-ibadan"]!);
    expect(wallet.balanceKobo).toBe(1_000_000 - PLAZA_TARIFFS_KOBO["lagos-ibadan"]!);

    const row = mockState.events[0];
    expect(row.chargeStatus).toBe("charged");
    expect(row.walletTxnId).toBe(mockState.walletTxns[0].id);
    expect(row.fraudScore).not.toBeNull();
    expect(mockState.audits.some((a) => a.action === "lane.charge")).toBe(true);
  });

  it("uses the exit amountKobo override when the controller supplies one", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    mockSeedTag({ tagEpc: EPC, walletId: wallet.id });

    const caller = lanesRouter.createCaller(makeLaneCtx(laneToken()));
    const result = await caller.ingestEvent(laneInput({ amountKobo: 12_345 }));

    expect(result.chargeStatus).toBe("charged");
    expect(result.amountKobo).toBe(12_345);
    expect(wallet.balanceKobo).toBe(1_000_000 - 12_345);
  });

  it("is idempotent: a replayed eventUid returns the stored result without double-charging", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    mockSeedTag({ tagEpc: EPC, walletId: wallet.id });

    const caller = lanesRouter.createCaller(makeLaneCtx(laneToken()));
    const input = laneInput();
    const first = await caller.ingestEvent(input);
    const second = await caller.ingestEvent(input);

    expect(first.chargeStatus).toBe("charged");
    expect(second.duplicate).toBe(true);
    expect(second.chargeStatus).toBe("charged");
    expect(second.laneEventId).toBe(first.laneEventId);
    expect(mockState.events).toHaveLength(1);
    expect(mockState.walletTxns).toHaveLength(1);
    expect(wallet.balanceKobo).toBe(1_000_000 - PLAZA_TARIFFS_KOBO["lagos-ibadan"]!);
  });

  it("blocks anti-passback: a second read at the same plaza within 5 minutes is not charged", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    mockSeedTag({ tagEpc: EPC, walletId: wallet.id });
    const t0 = new Date("2026-06-01T10:00:00Z");

    const caller = lanesRouter.createCaller(makeLaneCtx(laneToken()));
    const first = await caller.ingestEvent(laneInput({ occurredAt: t0 }));
    const second = await caller.ingestEvent(
      laneInput({ occurredAt: new Date(t0.getTime() + 2 * 60_000) }),
    );

    expect(first.chargeStatus).toBe("charged");
    expect(second.chargeStatus).toBe("failed");
    expect(second.antiPassbackBlocked).toBe(true);
    expect(second.reason).toBe("anti_passback");
    // Only one debit happened
    expect(mockState.walletTxns).toHaveLength(1);

    // A read 6 minutes later is outside the window and charges normally
    const third = await caller.ingestEvent(
      laneInput({ occurredAt: new Date(t0.getTime() + 6 * 60_000) }),
    );
    expect(third.chargeStatus).toBe("charged");
    expect(mockState.walletTxns).toHaveLength(2);
  });

  it("does not anti-passback-block the same tag at a different plaza", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    mockSeedTag({ tagEpc: EPC, walletId: wallet.id });
    const t0 = new Date("2026-06-01T10:00:00Z");

    const caller = lanesRouter.createCaller(makeLaneCtx(laneToken()));
    await caller.ingestEvent(laneInput({ occurredAt: t0 }));
    const other = await caller.ingestEvent(
      laneInput({ plazaId: "abuja-keffi", occurredAt: new Date(t0.getTime() + 60_000) }),
    );
    expect(other.chargeStatus).toBe("charged");
  });

  it("fails (and records) events for unknown tags", async () => {
    const caller = lanesRouter.createCaller(makeLaneCtx(laneToken()));
    const result = await caller.ingestEvent(laneInput());
    expect(result.chargeStatus).toBe("failed");
    expect(result.reason).toBe("unknown_tag");
    expect(mockState.events[0].chargeStatus).toBe("failed");
  });

  it("fails events for tags that are not active (issued/suspended/lost)", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    for (const [i, status] of ["issued", "suspended", "lost"].entries()) {
      mockSeedTag({ tagEpc: `${"F".repeat(20)}000${i}`, status, walletId: wallet.id });
    }
    const caller = lanesRouter.createCaller(makeLaneCtx(laneToken()));
    for (const [i, status] of ["issued", "suspended", "lost"].entries()) {
      const result = await caller.ingestEvent(laneInput({ tagEpc: `${"F".repeat(20)}000${i}` }));
      expect(result.chargeStatus).toBe("failed");
      expect(result.reason).toBe(`tag_${status}`);
    }
    expect(mockState.walletTxns).toHaveLength(0);
  });

  it("marks insufficient funds without ever taking the balance negative", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7, balanceKobo: 10_000 });
    mockSeedTag({ tagEpc: EPC, walletId: wallet.id });

    const caller = lanesRouter.createCaller(makeLaneCtx(laneToken()));
    const result = await caller.ingestEvent(laneInput()); // tariff 50_000 > 10_000

    expect(result.chargeStatus).toBe("insufficient");
    expect(result.balanceAfter).toBeUndefined();
    expect(wallet.balanceKobo).toBe(10_000);
    expect(mockState.walletTxns).toHaveLength(0);
    expect(mockState.events[0].chargeStatus).toBe("insufficient");
    expect(mockState.audits.some((a) => a.action === "lane.insufficient")).toBe(true);
  });

  it("records entry reads as free crossings without charging", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    mockSeedTag({ tagEpc: EPC, walletId: wallet.id });

    const caller = lanesRouter.createCaller(makeLaneCtx(laneToken()));
    const result = await caller.ingestEvent(laneInput({ direction: "entry" }));

    expect(result.chargeStatus).toBe("free");
    expect(wallet.balanceKobo).toBe(1_000_000);
    expect(mockState.walletTxns).toHaveLength(0);
  });

  it("falls back to the default tariff for unknown plazas", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    mockSeedTag({ tagEpc: EPC, walletId: wallet.id });

    const caller = lanesRouter.createCaller(makeLaneCtx(laneToken()));
    const result = await caller.ingestEvent(laneInput({ plazaId: "brand-new-plaza" }));
    expect(result.chargeStatus).toBe("charged");
    expect(result.amountKobo).toBe(PLAZA_TARIFFS_KOBO["default"]);
  });
});

// ── Batch ingest (store-and-forward) ──────────────────────────────────────────

describe("lanes.ingestBatch", () => {
  it("processes each item independently and never fails the batch", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    mockSeedTag({ tagEpc: EPC, walletId: wallet.id });

    const caller = lanesRouter.createCaller(makeLaneCtx(laneToken()));
    const batch = await caller.ingestBatch({
      readerId: READER_ID,
      events: [
        laneInput({ tagEpc: EPC }),                              // charged
        laneInput({ tagEpc: EPC_2 }),                            // unknown tag
        { eventUid: "not-even-a-uuid", tagEpc: "bad" },          // invalid payload
      ],
    });

    expect(batch.received).toBe(3);
    expect(batch.results).toHaveLength(3);
    expect(batch.results[0].chargeStatus).toBe("charged");
    expect(batch.results[1].chargeStatus).toBe("failed");
    expect(batch.results[1].reason).toBe("unknown_tag");
    expect(batch.results[2].chargeStatus).toBe("failed");
    expect(batch.results[2].reason).toBe("invalid_payload");
    expect(mockState.events).toHaveLength(2); // invalid payload recorded nothing
  });

  it("replays a synced batch idempotently", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    mockSeedTag({ tagEpc: EPC, walletId: wallet.id });
    const event = laneInput({ tagEpc: EPC });

    const caller = lanesRouter.createCaller(makeLaneCtx(laneToken()));
    await caller.ingestBatch({ readerId: READER_ID, events: [event] });
    const replay = await caller.ingestBatch({ readerId: READER_ID, events: [event] });

    expect(replay.results[0].duplicate).toBe(true);
    expect(replay.results[0].chargeStatus).toBe("charged");
    expect(mockState.walletTxns).toHaveLength(1);
  });

  it("requires a valid lane token", async () => {
    const caller = lanesRouter.createCaller(makeLaneCtx("bad-token"));
    await expect(
      caller.ingestBatch({ readerId: READER_ID, events: [laneInput()] }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

// ── Operator read endpoints ───────────────────────────────────────────────────

describe("lanes operator endpoints", () => {
  async function seedDayActivity() {
    const w1 = mockSeedWallet({ id: 1, userId: 7 });
    const w2 = mockSeedWallet({ id: 2, userId: 8, balanceKobo: 0 });
    mockSeedTag({ tagEpc: EPC, walletId: w1.id });
    mockSeedTag({ tagEpc: EPC_2, walletId: w2.id, vehiclePlate: "ABJ-777-ZZ" });

    const caller = lanesRouter.createCaller(makeLaneCtx(laneToken()));
    await caller.ingestEvent(laneInput({ tagEpc: EPC }));                  // charged 50_000
    await caller.ingestEvent(laneInput({ tagEpc: EPC_2 }));                // insufficient
  }

  it("recentEvents returns paginated events joined with tag + wallet info", async () => {
    await seedDayActivity();
    const caller = lanesRouter.createCaller(makeUserCtx("operator", 2));
    const page = await caller.recentEvents({ plazaId: "lagos-ibadan" });

    expect(page.events).toHaveLength(2);
    const charged = page.events.find((e: any) => e.chargeStatus === "charged");
    expect(charged.tag.vehiclePlate).toBe("LAG-123-XY");
    expect(charged.wallet.ownerUserId).toBe(7);

    const filtered = await caller.recentEvents({ plazaId: "lagos-ibadan", chargeStatus: "insufficient" });
    expect(filtered.events).toHaveLength(1);
    expect(filtered.events[0].tagEpc).toBe(EPC_2);
  });

  it("recentEvents is operator/admin only", async () => {
    const caller = lanesRouter.createCaller(makeUserCtx("user", 5));
    await expect(caller.recentEvents({ plazaId: "lagos-ibadan" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("laneSummary aggregates counts, revenue and top insufficient-fund tags", async () => {
    await seedDayActivity();
    const caller = lanesRouter.createCaller(makeUserCtx("admin", 3));
    const summary = await caller.laneSummary({ plazaId: "lagos-ibadan" });

    expect(summary.totalEvents).toBe(2);
    expect(summary.countsByStatus.charged).toBe(1);
    expect(summary.countsByStatus.insufficient).toBe(1);
    expect(summary.revenueKobo).toBe(PLAZA_TARIFFS_KOBO["lagos-ibadan"]);
    expect(summary.topInsufficientTags).toEqual([{ tagEpc: EPC_2, count: 1 }]);
  });

  it("tagHistory is visible to reviewers and the tag owner, forbidden to others", async () => {
    await seedDayActivity();

    const reviewer = lanesRouter.createCaller(makeUserCtx("reviewer", 4));
    const history = await reviewer.tagHistory({ tagEpc: EPC });
    expect(history.events).toHaveLength(1);

    const owner = lanesRouter.createCaller(makeUserCtx("user", 7));
    expect((await owner.tagHistory({ tagEpc: EPC })).events).toHaveLength(1);

    const stranger = lanesRouter.createCaller(makeUserCtx("user", 9));
    await expect(stranger.tagHistory({ tagEpc: EPC }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("tagHistory returns NOT_FOUND for unknown tags", async () => {
    const reviewer = lanesRouter.createCaller(makeUserCtx("reviewer", 4));
    await expect(reviewer.tagHistory({ tagEpc: EPC }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
