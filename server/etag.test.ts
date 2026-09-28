/**
 * eTag Lifecycle Tests (server/routers/etag.ts)
 * =============================================
 * Covers issue / activate / suspend / reportLost / decommission / replace /
 * linkWallet / myTags / getByEpc / getByPlate / list, including RBAC and
 * idempotency/conflict behaviour. All DB access runs against an in-memory
 * fake that evaluates the drizzle operators the router uses.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { rfidTags, laneEvents, walletAccounts, auditLogs } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

// ── In-memory store ───────────────────────────────────────────────────────────

type MockRow = Record<string, any>;

const mockState = {
  tags: [] as MockRow[],
  events: [] as MockRow[],
  wallets: [] as MockRow[],
  audits: [] as MockRow[],
  seq: { tag: 1, event: 1, audit: 1 },
};

function mockReset() {
  mockState.tags = [];
  mockState.events = [];
  mockState.wallets = [];
  mockState.audits = [];
  mockState.seq = { tag: 1, event: 1, audit: 1 };
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  mockState.wallets.push(row);
  return row;
}

function mockSeedTag(overrides: Partial<MockRow> = {}) {
  const row: MockRow = {
    id: mockState.seq.tag++,
    tagEpc: "AAAA00000000000000000001",
    tagType: "rfid_windshield",
    vehiclePlate: "LAG-123-XY",
    kycApplicationId: null,
    walletId: null,
    status: "issued",
    issuedBy: 1,
    issuedAt: new Date(),
    activatedAt: null,
    replacedByTagId: null,
    meta: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  mockState.tags.push(row);
  return row;
}

// ── Mini drizzle-SQL evaluator (eq/and/or/gte/ilike/inArray subset) ──────────

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

function mockSqlText(expr: any): string {
  return (expr?.queryChunks ?? [])
    .map((c: any) => (c?.constructor?.name === "StringChunk" ? c.value.join("") : ""))
    .join("");
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
    if (fields) {
      const keys = Object.keys(fields);
      if (keys.every((k) => /count\(/i.test(mockSqlText(fields[k])))) {
        return [{ [keys[0]]: rows.length }];
      }
    }
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
    if (table === rfidTags) {
      if (mockState.tags.some((t) => t.tagEpc === values.tagEpc)) {
        if (ignoreConflict) return [];
        const e = new Error("duplicate key value violates unique constraint") as any;
        e.code = "23505";
        throw e;
      }
      const row: MockRow = {
        id: mockState.seq.tag++,
        status: "issued",
        vehiclePlate: null,
        kycApplicationId: null,
        walletId: null,
        issuedBy: null,
        issuedAt: new Date(),
        activatedAt: null,
        replacedByTagId: null,
        meta: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...values,
      };
      mockState.tags.push(row);
      return [row];
    }
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
  const u: any = {
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
  return u;
}

const mockDb: any = {
  select: (fields?: Record<string, any>) => mockSelect(fields),
  insert: (table: any) => ({ values: (v: MockRow) => mockInsert(table, v) }),
  update: (table: any) => ({ set: (s: MockRow) => mockUpdate(table, s) }),
  transaction: (cb: (tx: any) => Promise<any>) => cb(mockDb),
};

// ── Mock the DB module ────────────────────────────────────────────────────────

vi.mock("./db", async () => {
  const actual = await vi.importActual<typeof import("./db")>("./db");
  return {
    ...actual,
    getDb: vi.fn(async () => mockDb),
  };
});

// ── Router under test ─────────────────────────────────────────────────────────

import { etagRouter } from "./routers/etag";

function makeCtx(role: string, userId = 1): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `user:${userId}`,
      name: `User ${userId}`,
      email: `user${userId}@test.com`,
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

const EPC_A = "AAAA0000000000000000000A";
const EPC_B = "BBBB0000000000000000000B";
const EPC_C = "CCCC0000000000000000000C";

beforeEach(() => {
  mockReset();
});

// ── issue ─────────────────────────────────────────────────────────────────────

describe("etag.issue", () => {
  it("issues a new tag with status 'issued' and writes an audit row", async () => {
    const caller = etagRouter.createCaller(makeCtx("operator"));
    const tag = await caller.issue({
      tagEpc: EPC_A,
      tagType: "rfid_windshield",
      vehiclePlate: "LAG-123-XY",
    });
    expect(tag.status).toBe("issued");
    expect(tag.tagEpc).toBe(EPC_A);
    expect(tag.issuedBy).toBe(1);
    expect(mockState.audits.some((a) => a.action === "etag.issue" && a.entityId === EPC_A)).toBe(true);
  });

  it("normalises lowercase EPC input to uppercase", async () => {
    const caller = etagRouter.createCaller(makeCtx("operator"));
    const tag = await caller.issue({ tagEpc: EPC_A.toLowerCase(), tagType: "etag" });
    expect(tag.tagEpc).toBe(EPC_A);
  });

  it("rejects a malformed EPC with a validation error", async () => {
    const caller = etagRouter.createCaller(makeCtx("operator"));
    await expect(caller.issue({ tagEpc: "NOT-AN-EPC", tagType: "etag" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("returns CONFLICT when the EPC is already registered", async () => {
    mockSeedTag({ tagEpc: EPC_A });
    const caller = etagRouter.createCaller(makeCtx("operator"));
    await expect(caller.issue({ tagEpc: EPC_A, tagType: "etag" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects issue when the target wallet does not exist", async () => {
    const caller = etagRouter.createCaller(makeCtx("operator"));
    await expect(caller.issue({ tagEpc: EPC_A, tagType: "etag", walletId: 999 }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("forbids plain users from issuing tags", async () => {
    const caller = etagRouter.createCaller(makeCtx("user", 5));
    await expect(caller.issue({ tagEpc: EPC_A, tagType: "etag" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ── activate ──────────────────────────────────────────────────────────────────

describe("etag.activate", () => {
  it("lets the wallet owner activate an issued tag", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    mockSeedTag({ tagEpc: EPC_A, status: "issued", walletId: wallet.id });
    const caller = etagRouter.createCaller(makeCtx("user", 7));
    const tag = await caller.activate({ tagEpc: EPC_A });
    expect(tag.status).toBe("active");
    expect(tag.activatedAt).toBeInstanceOf(Date);
  });

  it("lets an operator activate any issued tag", async () => {
    mockSeedTag({ tagEpc: EPC_A, status: "issued" });
    const caller = etagRouter.createCaller(makeCtx("operator", 2));
    const tag = await caller.activate({ tagEpc: EPC_A });
    expect(tag.status).toBe("active");
  });

  it("forbids a non-owner from activating someone else's tag", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    mockSeedTag({ tagEpc: EPC_A, status: "issued", walletId: wallet.id });
    const caller = etagRouter.createCaller(makeCtx("user", 8));
    await expect(caller.activate({ tagEpc: EPC_A }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects activation of a tag that is not in 'issued' state", async () => {
    mockSeedTag({ tagEpc: EPC_A, status: "suspended" });
    const caller = etagRouter.createCaller(makeCtx("operator", 2));
    await expect(caller.activate({ tagEpc: EPC_A }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("returns NOT_FOUND for an unknown EPC", async () => {
    const caller = etagRouter.createCaller(makeCtx("operator", 2));
    await expect(caller.activate({ tagEpc: EPC_A }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

// ── suspend / reportLost / decommission ──────────────────────────────────────

describe("etag.suspend / reportLost / decommission", () => {
  it("operator can suspend an active tag", async () => {
    mockSeedTag({ tagEpc: EPC_A, status: "active" });
    const caller = etagRouter.createCaller(makeCtx("operator", 2));
    const tag = await caller.suspend({ tagEpc: EPC_A, reason: "fraud review" });
    expect(tag.status).toBe("suspended");
  });

  it("plain users cannot suspend", async () => {
    mockSeedTag({ tagEpc: EPC_A, status: "active" });
    const caller = etagRouter.createCaller(makeCtx("user", 5));
    await expect(caller.suspend({ tagEpc: EPC_A }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("owner can report their own tag lost", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    mockSeedTag({ tagEpc: EPC_A, status: "active", walletId: wallet.id });
    const caller = etagRouter.createCaller(makeCtx("user", 7));
    const tag = await caller.reportLost({ tagEpc: EPC_A });
    expect(tag.status).toBe("lost");
    expect(mockState.audits.some((a) => a.action === "etag.reportLost")).toBe(true);
  });

  it("non-owner cannot report someone else's tag lost", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    mockSeedTag({ tagEpc: EPC_A, status: "active", walletId: wallet.id });
    const caller = etagRouter.createCaller(makeCtx("user", 8));
    await expect(caller.reportLost({ tagEpc: EPC_A }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reportLost on an already-lost tag fails", async () => {
    mockSeedTag({ tagEpc: EPC_A, status: "lost" });
    const caller = etagRouter.createCaller(makeCtx("operator", 2));
    await expect(caller.reportLost({ tagEpc: EPC_A }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("operator can decommission a tag (terminal)", async () => {
    mockSeedTag({ tagEpc: EPC_A, status: "lost" });
    const caller = etagRouter.createCaller(makeCtx("admin", 3));
    const tag = await caller.decommission({ tagEpc: EPC_A });
    expect(tag.status).toBe("decommissioned");
  });
});

// ── replace ───────────────────────────────────────────────────────────────────

describe("etag.replace", () => {
  it("atomically retires the old tag and activates the new one with wallet+plate carried over", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    const old = mockSeedTag({ tagEpc: EPC_A, status: "active", walletId: wallet.id, vehiclePlate: "ABJ-999-KK" });
    const caller = etagRouter.createCaller(makeCtx("operator", 2));

    const result = await caller.replace({ oldTagEpc: EPC_A, newTagEpc: EPC_B });

    expect(result.oldTag.status).toBe("replaced");
    expect(result.oldTag.replacedByTagId).toBe(result.newTag.id);
    expect(result.newTag.status).toBe("active");
    expect(result.newTag.walletId).toBe(wallet.id);
    expect(result.newTag.vehiclePlate).toBe("ABJ-999-KK");
    expect(result.newTag.activatedAt).toBeInstanceOf(Date);
    // Both mutations visible in the store (single transaction)
    expect(mockState.tags.find((t) => t.id === old.id)?.status).toBe("replaced");
    expect(mockState.tags.some((t) => t.tagEpc === EPC_B)).toBe(true);
  });

  it("returns CONFLICT when the replacement EPC already exists", async () => {
    mockSeedTag({ tagEpc: EPC_A, status: "active" });
    mockSeedTag({ tagEpc: EPC_B, status: "issued" });
    const caller = etagRouter.createCaller(makeCtx("operator", 2));
    await expect(caller.replace({ oldTagEpc: EPC_A, newTagEpc: EPC_B }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    // Rollback: old tag must still be active
    expect(mockState.tags.find((t) => t.tagEpc === EPC_A)?.status).toBe("active");
  });

  it("rejects replacing a tag with itself", async () => {
    mockSeedTag({ tagEpc: EPC_A, status: "active" });
    const caller = etagRouter.createCaller(makeCtx("operator", 2));
    await expect(caller.replace({ oldTagEpc: EPC_A, newTagEpc: EPC_A }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects replacing a terminally decommissioned tag", async () => {
    mockSeedTag({ tagEpc: EPC_A, status: "decommissioned" });
    const caller = etagRouter.createCaller(makeCtx("operator", 2));
    await expect(caller.replace({ oldTagEpc: EPC_A, newTagEpc: EPC_C }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ── linkWallet ────────────────────────────────────────────────────────────────

describe("etag.linkWallet", () => {
  it("owner links their own wallet to an unbound tag", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    mockSeedTag({ tagEpc: EPC_A, status: "active", walletId: null });
    const caller = etagRouter.createCaller(makeCtx("user", 7));
    const tag = await caller.linkWallet({ tagEpc: EPC_A, walletId: wallet.id });
    expect(tag.walletId).toBe(wallet.id);
  });

  it("forbids linking to a wallet the caller does not own", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    mockSeedTag({ tagEpc: EPC_A, status: "active", walletId: null });
    const caller = etagRouter.createCaller(makeCtx("user", 8));
    await expect(caller.linkWallet({ tagEpc: EPC_A, walletId: wallet.id }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("operator can relink any tag", async () => {
    const w1 = mockSeedWallet({ id: 1, userId: 7 });
    const w2 = mockSeedWallet({ id: 2, userId: 8 });
    mockSeedTag({ tagEpc: EPC_A, status: "active", walletId: w1.id });
    const caller = etagRouter.createCaller(makeCtx("operator", 2));
    const tag = await caller.linkWallet({ tagEpc: EPC_A, walletId: w2.id });
    expect(tag.walletId).toBe(w2.id);
  });

  it("rejects linking a lost tag", async () => {
    const wallet = mockSeedWallet({ id: 1, userId: 7 });
    mockSeedTag({ tagEpc: EPC_A, status: "lost", walletId: wallet.id });
    const caller = etagRouter.createCaller(makeCtx("user", 7));
    await expect(caller.linkWallet({ tagEpc: EPC_A, walletId: wallet.id }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ── read endpoints ────────────────────────────────────────────────────────────

describe("etag read endpoints", () => {
  it("myTags returns only tags bound to the caller's wallet", async () => {
    const w1 = mockSeedWallet({ id: 1, userId: 7 });
    const w2 = mockSeedWallet({ id: 2, userId: 8 });
    mockSeedTag({ tagEpc: EPC_A, walletId: w1.id });
    mockSeedTag({ tagEpc: EPC_B, walletId: w2.id });
    const caller = etagRouter.createCaller(makeCtx("user", 7));
    const tags = await caller.myTags();
    expect(tags.map((t: any) => t.tagEpc)).toEqual([EPC_A]);
  });

  it("myTags returns [] when the caller has no wallet", async () => {
    mockSeedTag({ tagEpc: EPC_A });
    const caller = etagRouter.createCaller(makeCtx("user", 9));
    expect(await caller.myTags()).toEqual([]);
  });

  it("getByEpc allows a reviewer and forbids a plain user", async () => {
    mockSeedTag({ tagEpc: EPC_A });
    const reviewer = etagRouter.createCaller(makeCtx("reviewer", 4));
    expect((await reviewer.getByEpc({ tagEpc: EPC_A })).tagEpc).toBe(EPC_A);
    const user = etagRouter.createCaller(makeCtx("user", 5));
    await expect(user.getByEpc({ tagEpc: EPC_A }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("getByPlate finds tags by plate (reviewer)", async () => {
    mockSeedTag({ tagEpc: EPC_A, vehiclePlate: "LAG-123-XY" });
    const caller = etagRouter.createCaller(makeCtx("reviewer", 4));
    const tags = await caller.getByPlate({ vehiclePlate: "LAG-123-XY" });
    expect(tags).toHaveLength(1);
  });

  it("list paginates, filters by status and searches by plate", async () => {
    for (let i = 0; i < 5; i++) {
      mockSeedTag({
        tagEpc: `AAAA${"0".repeat(18)}${10 + i}`,
        status: i % 2 === 0 ? "active" : "suspended",
        vehiclePlate: `LAG-00${i}-AA`,
      });
    }
    const caller = etagRouter.createCaller(makeCtx("operator", 2));

    const active = await caller.list({ status: "active" });
    expect(active.total).toBe(3);

    const page = await caller.list({ page: 2, limit: 2 });
    expect(page.tags).toHaveLength(2);
    expect(page.total).toBe(5);

    const found = await caller.list({ search: "LAG-003" });
    expect(found.total).toBe(1);
  });
});
