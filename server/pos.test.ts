/**
 * POS Middleware Router Tests
 * ===========================
 * Covers the card-POS middleware (server/routers/pos.ts):
 *
 *  - Terminal lifecycle: register (conflict), update, revoke, list, RBAC
 *  - Terminal-token auth (HMAC x-terminal-token): heartbeat, rejected tokens
 *  - recordTransaction: amount bounds, card last4 validation, idempotent
 *    txnUid replay, atomic wallet top-up credit (no double-credit on replay),
 *    tag-EPC wallet resolution, credit failure surfaced + row marked pending
 *  - batchSync: per-item isolation, malformed items, terminal mismatch, ≤200
 *  - reverseTransaction: offsetting ledger entry, idempotency, 4-eyes >₦50,000
 *  - listTransactions / terminalDailySummary: filters, pagination, aggregation
 *
 * All DB access is mocked with an in-memory store behind a minimal drizzle
 * query-builder fake — no live PostgreSQL required.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID, createHmac } from "crypto";
import { Column, SQL, Table, is } from "drizzle-orm";
import type { TrpcContext } from "./_core/context";

process.env.POS_HMAC_SECRET = "pos-test-secret";

// ── In-memory store ───────────────────────────────────────────────────────────

interface FakeTerminal {
  id: number; terminalId: string; plazaId: string; vendor: string;
  serialNumber: string | null; status: string; registeredBy: number | null;
  lastSeenAt: Date | null; createdAt: Date;
}
interface FakeTxn {
  id: number; txnUid: string; terminalId: number; type: string;
  amountKobo: number; cardLast4: string | null; cardScheme: string | null;
  rrn: string | null; stan: string | null; status: string;
  walletId: number | null; laneEventId: number | null;
  occurredAt: Date; syncedAt: Date | null;
}
interface FakeTag { id: number; tagEpc: string; walletId: number | null; status: string }
interface FakeWallet { id: number; userId: number; balanceKobo: number }
interface FakeUser { id: number; role: string }
interface LedgerEntry {
  id: number; walletId: number; userId: number; type: string;
  amountKobo: number; externalRef: string; description: string;
}

const state = {
  terminals: [] as FakeTerminal[],
  txns: [] as FakeTxn[],
  tags: [] as FakeTag[],
  wallets: [] as FakeWallet[],
  users: [] as FakeUser[],
  ledger: [] as LedgerEntry[],
  nextTerminalId: 1,
  nextTxnId: 1,
  nextLedgerId: 1,
};

function resetState() {
  state.terminals = [];
  state.txns = [];
  state.tags = [];
  state.wallets = [];
  state.users = [
    { id: 1, role: "admin" },
    { id: 2, role: "admin" },
    { id: 3, role: "operator" },
    { id: 4, role: "user" },
  ];
  state.ledger = [];
  state.nextTerminalId = 1;
  state.nextTxnId = 1;
  state.nextLedgerId = 1;
}

function seedTerminal(over: Partial<FakeTerminal> = {}): FakeTerminal {
  const id = state.nextTerminalId++;
  const t: FakeTerminal = {
    id,
    terminalId: over.terminalId ?? `TERM-${String(id).padStart(3, "0")}`,
    plazaId: "PLAZA-LAG-01",
    vendor: "moniepoint",
    serialNumber: `SN-${id}`,
    status: "active",
    registeredBy: 1,
    lastSeenAt: null,
    createdAt: new Date(),
    ...over,
  };
  state.terminals.push(t);
  return t;
}

function seedWallet(userId: number, balanceKobo = 0): FakeWallet {
  const w: FakeWallet = { id: userId * 100, userId, balanceKobo };
  state.wallets.push(w);
  return w;
}

// ── Minimal drizzle fake ──────────────────────────────────────────────────────
// Decodes the exact query constructs used by server/routers/pos.ts:
// eq/and/gte/lt/lte on plain columns, leftJoin on eq(colA, colB), desc()
// ordering, limit/offset, count() projection, insert/update with returning().

import { posTerminals, posTransactions, rfidTags, users, walletAccounts } from "../drizzle/schema";

function storeFor(table: unknown): Array<Record<string, unknown>> {
  if (is(table as object, Table)) {
    if (table === posTerminals) return state.terminals as never;
    if (table === posTransactions) return state.txns as never;
    if (table === rfidTags) return state.tags as never;
    if (table === walletAccounts) return state.wallets as never;
    if (table === users) return state.users as never;
  }
  throw new Error(`fakeDb: unregistered table ${String((table as { constructor?: { name?: string } })?.constructor?.name)}`);
}

interface Joined { left: Record<string, unknown>; right: Record<string, unknown> | null }

function flattenChunks(node: SQL): unknown[] {
  const out: unknown[] = [];
  for (const c of node.queryChunks as unknown[]) {
    if (c instanceof SQL) out.push(...flattenChunks(c));
    else out.push(c);
  }
  return out;
}

function normVal(v: unknown): unknown {
  return v instanceof Date ? v.getTime() : v;
}

function colValue(j: Joined, col: Column, leftTable: unknown, rightTable?: unknown): unknown {
  const src = col.table === leftTable ? j.left : col.table === rightTable ? j.right : j.left;
  return src ? src[col.name] : undefined;
}

type Pred = (j: Joined) => boolean;

function decodeWhere(cond: unknown, leftTable: unknown, rightTable?: unknown): Pred {
  if (!cond) return () => true;
  const tokens = flattenChunks(cond as SQL);
  const preds: Pred[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk instanceof Column) {
      const opChunk = tokens[i + 1] as { value?: string[] } | undefined;
      const param = tokens[i + 2] as { value?: unknown } | undefined;
      const op = (opChunk?.value?.[0] ?? "").trim();
      const val = param && "value" in param ? param.value : undefined;
      const get = (j: Joined) => colValue(j, tk, leftTable, rightTable);
      if (op === "=") preds.push((j) => normVal(get(j)) === normVal(val));
      else if (op === ">=") preds.push((j) => Number(normVal(get(j))) >= Number(normVal(val)));
      else if (op === ">") preds.push((j) => Number(normVal(get(j))) > Number(normVal(val)));
      else if (op === "<=") preds.push((j) => Number(normVal(get(j))) <= Number(normVal(val)));
      else if (op === "<") preds.push((j) => Number(normVal(get(j))) < Number(normVal(val)));
      else throw new Error(`fakeDb: unsupported operator "${op}"`);
      i += 2;
    }
  }
  return (j) => preds.every((p) => p(j));
}

function decodeOrder(orderSql: SQL): { col: Column; dir: 1 | -1 } {
  const tokens = flattenChunks(orderSql);
  const col = tokens.find((t): t is Column => t instanceof Column);
  if (!col) throw new Error("fakeDb: orderBy without column");
  const text = tokens
    .filter((t): t is { value: string[] } => Array.isArray((t as { value?: unknown }).value))
    .map((t) => t.value.join(""))
    .join("");
  return { col, dir: /desc/i.test(text) ? -1 : 1 };
}

function projectRow(j: Joined, fields: Record<string, unknown>, leftTable: unknown, rightTable?: unknown) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof SQL) out[k] = "__count__";
    else if (is(v as object, Table)) out[k] = v === leftTable ? j.left : j.right;
    else if (v instanceof Column) out[k] = colValue(j, v, leftTable, rightTable);
    else out[k] = undefined;
  }
  return out;
}

function runSelect(q: {
  table: unknown; fields?: Record<string, unknown>; joinTable?: unknown; joinOn?: unknown;
  where?: unknown; orders: SQL[]; limitN?: number; offsetN: number;
}): Array<Record<string, unknown>> {
  const leftRows = storeFor(q.table);
  let joined: Joined[] = leftRows.map((r) => ({ left: r, right: null }));

  if (q.joinTable) {
    const cols = flattenChunks(q.joinOn as SQL).filter((t): t is Column => t instanceof Column);
    const leftCol = cols.find((c) => c.table === q.table)!;
    const rightCol = cols.find((c) => c.table === q.joinTable)!;
    const rightRows = storeFor(q.joinTable);
    joined = joined.map((j) => ({
      left: j.left,
      right: rightRows.find((rr) => normVal(rr[rightCol.name]) === normVal(j.left[leftCol.name])) ?? null,
    }));
  }

  const pred = decodeWhere(q.where, q.table, q.joinTable);
  joined = joined.filter(pred);

  // count() projection — computed over the filtered set, before pagination.
  if (q.fields && Object.values(q.fields).some((v) => v instanceof SQL)) {
    const alias = Object.keys(q.fields)[0]!;
    return [{ [alias]: joined.length }];
  }

  for (const o of q.orders) {
    const { col, dir } = decodeOrder(o);
    joined.sort((a, b) => {
      const av = Number(normVal(colValue(a, col, q.table, q.joinTable)) ?? 0);
      const bv = Number(normVal(colValue(b, col, q.table, q.joinTable)) ?? 0);
      return (av - bv) * dir;
    });
  }

  if (q.offsetN) joined = joined.slice(q.offsetN);
  if (q.limitN !== undefined) joined = joined.slice(0, q.limitN);

  if (!q.fields) return joined.map((j) => j.left);
  return joined.map((j) => projectRow(j, q.fields!, q.table, q.joinTable));
}

function makeFakeDb() {
  const db: Record<string, unknown> = {};

  db.select = (fields?: Record<string, unknown>) => ({
    from: (table: unknown) => {
      const q = {
        table, fields, joinTable: undefined as unknown, joinOn: undefined as unknown,
        where: undefined as unknown, orders: [] as SQL[], limitN: undefined as number | undefined, offsetN: 0,
      };
      const chain: Record<string, unknown> = {
        leftJoin: (t: unknown, on: unknown) => { q.joinTable = t; q.joinOn = on; return chain; },
        where: (c: unknown) => { q.where = c; return chain; },
        orderBy: (...cols: SQL[]) => { q.orders = cols; return chain; },
        limit: (n: number) => { q.limitN = n; return chain; },
        offset: (n: number) => { q.offsetN = n; return chain; },
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(() => runSelect(q)).then(resolve, reject),
      };
      return chain;
    },
  });

  db.insert = (table: unknown) => ({
    values: (v: Record<string, unknown>) => {
      let onConflictDoNothing = false;
      const doInsert = () => {
        const store = storeFor(table);
        if (table === posTransactions && store.some((r) => r.txnUid === v.txnUid)) {
          if (onConflictDoNothing) return [];
          throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
        }
        if (table === posTerminals && store.some((r) => r.terminalId === v.terminalId)) {
          if (onConflictDoNothing) return [];
          throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
        }
        const row: Record<string, unknown> = { ...v };
        if (table === posTerminals) {
          row.id ??= state.nextTerminalId++;
          row.status ??= "active";
          row.lastSeenAt ??= null;
          row.createdAt ??= new Date();
        }
        if (table === posTransactions) {
          row.id ??= state.nextTxnId++;
          row.status ??= "pending";
          row.syncedAt ??= new Date();
        }
        if (table === rfidTags) row.id ??= state.tags.length + 1;
        store.push(row);
        return [row];
      };
      const chain: Record<string, unknown> = {
        onConflictDoNothing: () => { onConflictDoNothing = true; return chain; },
        returning: () => Promise.resolve(doInsert()),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(doInsert).then(resolve, reject),
      };
      return chain;
    },
  });

  db.update = (table: unknown) => ({
    set: (setObj: Record<string, unknown>) => ({
      where: (cond: unknown) => {
        const doUpdate = () => {
          const store = storeFor(table);
          const pred = decodeWhere(cond, table);
          const updated: Array<Record<string, unknown>> = [];
          for (const row of store) {
            if (pred({ left: row, right: null })) {
              Object.assign(row, setObj);
              updated.push(row);
            }
          }
          return updated;
        };
        const chain: Record<string, unknown> = {
          returning: () => Promise.resolve(doUpdate()),
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve().then(doUpdate).then(resolve, reject),
        };
        return chain;
      },
    }),
  });

  db.transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return db;
}

const fakeDb = makeFakeDb();

// ── Mock the DB module (functional wallet atomic ops over the in-memory store) ─

vi.mock("./db", () => ({
  getDb: vi.fn(async () => fakeDb),
  creditWalletAtomic: vi.fn(async (params: { userId: number; amountKobo: number; externalRef: string; type: string; description: string }) => {
    const wallet = state.wallets.find((w) => w.userId === params.userId);
    if (!wallet) return { status: "no_wallet" as const };
    if (state.ledger.some((l) => l.externalRef === params.externalRef)) return { status: "duplicate" as const };
    wallet.balanceKobo += params.amountKobo;
    const entry: LedgerEntry = {
      id: state.nextLedgerId++, walletId: wallet.id, userId: wallet.userId,
      type: params.type, amountKobo: params.amountKobo,
      externalRef: params.externalRef, description: params.description,
    };
    state.ledger.push(entry);
    return { status: "credited" as const, walletId: wallet.id, transactionId: entry.id, newBalanceKobo: wallet.balanceKobo };
  }),
  debitWalletAtomic: vi.fn(async (params: { userId: number; amountKobo: number; externalRef: string; description: string; plazaId?: string }) => {
    const wallet = state.wallets.find((w) => w.userId === params.userId);
    if (!wallet) return { status: "no_wallet" as const };
    if (state.ledger.some((l) => l.externalRef === params.externalRef)) return { status: "duplicate" as const };
    if (wallet.balanceKobo < params.amountKobo) return { status: "insufficient_funds" as const, balanceKobo: wallet.balanceKobo };
    wallet.balanceKobo -= params.amountKobo;
    const entry: LedgerEntry = {
      id: state.nextLedgerId++, walletId: wallet.id, userId: wallet.userId,
      type: "reversal", amountKobo: params.amountKobo,
      externalRef: params.externalRef, description: params.description,
    };
    state.ledger.push(entry);
    return { status: "debited" as const, walletId: wallet.id, transactionId: entry.id, newBalanceKobo: wallet.balanceKobo };
  }),
}));

// ── Mock audit + kafka (guarded side-effects) ─────────────────────────────────

const mockWriteAuditLog = vi.fn(async () => {});
vi.mock("./_core/audit", () => ({
  audit: vi.fn(async () => {}),
  writeAuditLog: mockWriteAuditLog,
}));

const mockPublishEvent = vi.fn(async () => true);
vi.mock("./integrations/kafka", () => ({
  TOPICS: { tollCharges: "toll.charges", walletEvents: "wallet.events", kycEvents: "kyc.events", auditEvents: "audit.events" },
  kafkaEnabled: () => true,
  publishEvent: mockPublishEvent,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getPosRouter() {
  const { posRouter } = await import("./routers/pos");
  return posRouter;
}

function makeUserCtx(role: string, id = 1): TrpcContext {
  return {
    user: {
      id, openId: `user:${id}`, name: `User ${id}`, email: null,
      role, loginMethod: "oauth",
      createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
    } as never,
    req: { protocol: "https", headers: {}, socket: { remoteAddress: "127.0.0.1" } } as never,
    res: { cookie: vi.fn(), clearCookie: vi.fn() } as never,
  };
}

function makeTerminalCtx(token?: string): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: token ? { "x-terminal-token": token } : {}, socket: { remoteAddress: "127.0.0.1" } } as never,
    res: {} as never,
  };
}

function terminalToken(terminalId: string): string {
  return createHmac("sha256", "pos-test-secret").update(`terminal:${terminalId}`).digest("hex");
}

function validRecord(over: Record<string, unknown> = {}) {
  return {
    txnUid: randomUUID(),
    terminalId: "TERM-001",
    type: "toll_payment" as const,
    amountKobo: 50_000,
    cardLast4: "1234",
    cardScheme: "verve",
    rrn: "123456789012",
    stan: "000123",
    occurredAt: new Date(),
    ...over,
  };
}

// ── Terminal management ───────────────────────────────────────────────────────

describe("pos.registerTerminal", () => {
  beforeEach(() => { resetState(); vi.clearAllMocks(); });

  it("registers a terminal as active", async () => {
    const caller = (await getPosRouter()).createCaller(makeUserCtx("admin"));
    const row = (await caller.registerTerminal({
      terminalId: "TERM-001", plazaId: "PLAZA-LAG-01", vendor: "moniepoint", serialNumber: "SN-1",
    })) as FakeTerminal;
    expect(row.terminalId).toBe("TERM-001");
    expect(row.status).toBe("active");
    expect(row.registeredBy).toBe(1);
    expect(state.terminals).toHaveLength(1);
  });

  it("rejects duplicate terminalId with CONFLICT", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const caller = (await getPosRouter()).createCaller(makeUserCtx("admin"));
    await expect(
      caller.registerTerminal({ terminalId: "TERM-001", plazaId: "P", vendor: "paystack" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects non-admin callers", async () => {
    const caller = (await getPosRouter()).createCaller(makeUserCtx("operator", 3));
    await expect(
      caller.registerTerminal({ terminalId: "T-NEW", plazaId: "P", vendor: "paystack" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("pos.updateTerminal / revokeTerminal / listTerminals", () => {
  beforeEach(() => { resetState(); vi.clearAllMocks(); });

  it("updates status and plaza", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const caller = (await getPosRouter()).createCaller(makeUserCtx("admin"));
    const row = (await caller.updateTerminal({ terminalId: "TERM-001", status: "maintenance", plazaId: "PLAZA-ABJ-02" })) as FakeTerminal;
    expect(row.status).toBe("maintenance");
    expect(row.plazaId).toBe("PLAZA-ABJ-02");
  });

  it("returns NOT_FOUND for unknown terminal", async () => {
    const caller = (await getPosRouter()).createCaller(makeUserCtx("admin"));
    await expect(caller.updateTerminal({ terminalId: "NOPE", status: "inactive" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("revokes a terminal and is idempotent", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const caller = (await getPosRouter()).createCaller(makeUserCtx("admin"));
    const first = (await caller.revokeTerminal({ terminalId: "TERM-001", reason: "tamper detected" })) as { status: string; alreadyRevoked: boolean };
    expect(first.status).toBe("revoked");
    expect(first.alreadyRevoked).toBe(false);
    const second = (await caller.revokeTerminal({ terminalId: "TERM-001" })) as { alreadyRevoked: boolean };
    expect(second.alreadyRevoked).toBe(true);
  });

  it("lists terminals with plaza/status filters and pagination", async () => {
    seedTerminal({ terminalId: "T-A", plazaId: "PLAZA-1" });
    seedTerminal({ terminalId: "T-B", plazaId: "PLAZA-1", status: "inactive" });
    seedTerminal({ terminalId: "T-C", plazaId: "PLAZA-2" });
    const caller = (await getPosRouter()).createCaller(makeUserCtx("admin"));

    const all = await caller.listTerminals({ limit: 50, offset: 0 });
    expect(all.total).toBe(3);

    const plaza1 = await caller.listTerminals({ limit: 50, offset: 0, plazaId: "PLAZA-1" });
    expect(plaza1.total).toBe(2);

    const active = await caller.listTerminals({ limit: 50, offset: 0, status: "active" });
    expect(active.total).toBe(2);

    const page = await caller.listTerminals({ limit: 2, offset: 2 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(3);
  });
});

// ── Terminal heartbeat ────────────────────────────────────────────────────────

describe("pos.terminalHeartbeat", () => {
  beforeEach(() => { resetState(); vi.clearAllMocks(); });

  it("accepts a valid token and updates lastSeenAt", async () => {
    const t = seedTerminal({ terminalId: "TERM-001" });
    const caller = (await getPosRouter()).createCaller(makeTerminalCtx(terminalToken("TERM-001")));
    const res = await caller.terminalHeartbeat({ terminalId: "TERM-001" });
    expect(res.ok).toBe(true);
    expect(state.terminals.find((x) => x.id === t.id)!.lastSeenAt).toBeInstanceOf(Date);
  });

  it("rejects an invalid token with UNAUTHORIZED", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const caller = (await getPosRouter()).createCaller(makeTerminalCtx("deadbeef".repeat(8)));
    await expect(caller.terminalHeartbeat({ terminalId: "TERM-001" }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a missing token with UNAUTHORIZED", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const caller = (await getPosRouter()).createCaller(makeTerminalCtx());
    await expect(caller.terminalHeartbeat({ terminalId: "TERM-001" }))
      .rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a revoked terminal even with a valid token", async () => {
    seedTerminal({ terminalId: "TERM-001", status: "revoked" });
    const caller = (await getPosRouter()).createCaller(makeTerminalCtx(terminalToken("TERM-001")));
    await expect(caller.terminalHeartbeat({ terminalId: "TERM-001" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ── recordTransaction ─────────────────────────────────────────────────────────

describe("pos.recordTransaction", () => {
  beforeEach(() => { resetState(); vi.clearAllMocks(); });

  async function terminalCaller(tid = "TERM-001") {
    return (await getPosRouter()).createCaller(makeTerminalCtx(terminalToken(tid)));
  }

  it("records an approved toll_payment", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const caller = await terminalCaller();
    const rec = validRecord();
    const res = await caller.recordTransaction(rec);
    expect(res.status).toBe("approved");
    expect(res.duplicate).toBe(false);
    expect(state.txns).toHaveLength(1);
    expect(state.txns[0]!.amountKobo).toBe(50_000);
    expect(state.txns[0]!.status).toBe("approved");
    expect(state.txns[0]!.syncedAt).toBeInstanceOf(Date);
  });

  it("enforces amount bounds (100..10,000,000 kobo)", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const caller = await terminalCaller();
    await expect(caller.recordTransaction(validRecord({ amountKobo: 99 }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.recordTransaction(validRecord({ amountKobo: 10_000_001 }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.txns).toHaveLength(0);
  });

  it("enforces cardLast4 format", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const caller = await terminalCaller();
    await expect(caller.recordTransaction(validRecord({ cardLast4: "12a4" }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.recordTransaction(validRecord({ cardLast4: "123" }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("wallet_topup credits the wallet atomically", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const wallet = seedWallet(42, 10_000);
    const caller = await terminalCaller();
    const rec = validRecord({ type: "wallet_topup", walletId: wallet.id });
    const res = await caller.recordTransaction(rec);
    expect(res.status).toBe("approved");
    expect(res.walletCredit).toMatchObject({ status: "credited", newBalanceKobo: 60_000 });
    expect(wallet.balanceKobo).toBe(60_000);
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]!.externalRef).toBe(`POS-${rec.txnUid}`);
    expect(state.ledger[0]!.description).toContain("POS top-up @ PLAZA-LAG-01");
  });

  it("txnUid replay is idempotent and does NOT double-credit", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const wallet = seedWallet(42, 0);
    const caller = await terminalCaller();
    const rec = validRecord({ type: "wallet_topup", walletId: wallet.id });
    const first = await caller.recordTransaction(rec);
    expect(first.duplicate).toBe(false);
    const replay = await caller.recordTransaction(rec);
    expect(replay.duplicate).toBe(true);
    expect(replay.status).toBe("approved");
    expect(wallet.balanceKobo).toBe(50_000);
    expect(state.ledger).toHaveLength(1);
    expect(state.txns).toHaveLength(1);
  });

  it("resolves the wallet via an active RFID tag (tagEpc)", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const wallet = seedWallet(7, 0);
    state.tags.push({ id: 1, tagEpc: "EPC-ABC-123", walletId: wallet.id, status: "active" });
    const caller = await terminalCaller();
    const res = await caller.recordTransaction(validRecord({ type: "wallet_topup", tagEpc: "EPC-ABC-123" }));
    expect(res.walletCredit).toMatchObject({ status: "credited" });
    expect(wallet.balanceKobo).toBe(50_000);
    expect(state.txns[0]!.walletId).toBe(wallet.id);
  });

  it("rejects a top-up whose tag has no active wallet", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    state.tags.push({ id: 1, tagEpc: "EPC-SUSP", walletId: null, status: "suspended" });
    const caller = await terminalCaller();
    await expect(caller.recordTransaction(validRecord({ type: "wallet_topup", tagEpc: "EPC-SUSP" })))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(state.txns).toHaveLength(0);
  });

  it("surfaces credit failure and marks the transaction pending", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const caller = await terminalCaller();
    // walletId 999 does not exist → credit fails loudly
    await expect(caller.recordTransaction(validRecord({ type: "wallet_topup", walletId: 999 })))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(state.txns).toHaveLength(1);
    expect(state.txns[0]!.status).toBe("pending");
  });

  it("rejects transactions from a revoked terminal", async () => {
    seedTerminal({ terminalId: "TERM-001", status: "revoked" });
    const caller = await terminalCaller();
    await expect(caller.recordTransaction(validRecord())).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.txns).toHaveLength(0);
  });

  it("rejects transactions from an inactive terminal", async () => {
    seedTerminal({ terminalId: "TERM-001", status: "inactive" });
    const caller = await terminalCaller();
    await expect(caller.recordTransaction(validRecord())).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects requests without a valid terminal token", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const caller = (await getPosRouter()).createCaller(makeTerminalCtx("bad-token"));
    await expect(caller.recordTransaction(validRecord())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("emits audit + kafka events on success", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const caller = await terminalCaller();
    const rec = validRecord();
    await caller.recordTransaction(rec);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "pos.txn.record", entity: "pos_transaction", entityId: rec.txnUid,
    }));
    expect(mockPublishEvent).toHaveBeenCalledWith("wallet.events", `POS-${rec.txnUid}`, expect.objectContaining({ kind: "pos.transaction" }));
  });
});

// ── batchSync ─────────────────────────────────────────────────────────────────

describe("pos.batchSync", () => {
  beforeEach(() => { resetState(); vi.clearAllMocks(); });

  async function terminalCaller(tid = "TERM-001") {
    return (await getPosRouter()).createCaller(makeTerminalCtx(terminalToken(tid)));
  }

  it("syncs a batch and isolates per-item failures", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const wallet = seedWallet(42, 0);
    const okToll = validRecord();
    const okTopup = validRecord({ type: "wallet_topup", walletId: wallet.id });
    const badCredit = validRecord({ type: "wallet_topup", walletId: 999 });
    const caller = await terminalCaller();
    const res = await caller.batchSync({ terminalId: "TERM-001", records: [okToll, okTopup, badCredit] });

    expect(res.succeeded).toBe(2);
    expect(res.failed).toBe(1);
    const byUid = new Map(res.results.map((r) => [r.txnUid, r]));
    expect(byUid.get(okToll.txnUid)).toMatchObject({ status: "approved", error: null });
    expect(byUid.get(okTopup.txnUid)).toMatchObject({ status: "approved", error: null });
    expect(byUid.get(badCredit.txnUid)!.error).toBeTruthy();
    // failed item row persisted as pending; others synced
    expect(state.txns.find((t) => t.txnUid === badCredit.txnUid)!.status).toBe("pending");
    expect(state.txns.find((t) => t.txnUid === okToll.txnUid)!.syncedAt).toBeInstanceOf(Date);
    expect(wallet.balanceKobo).toBe(50_000); // only the good top-up credited
  });

  it("isolates malformed records without aborting the batch", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const good = validRecord();
    const caller = await terminalCaller();
    const res = await caller.batchSync({
      terminalId: "TERM-001",
      records: [{ txnUid: 12345, garbage: true }, good],
    });
    expect(res.succeeded).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.results[0]!.error).toBeTruthy();
    expect(res.results[1]).toMatchObject({ txnUid: good.txnUid, status: "approved" });
  });

  it("flags records whose terminalId does not match the authenticated terminal", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const caller = await terminalCaller();
    const res = await caller.batchSync({
      terminalId: "TERM-001",
      records: [validRecord({ terminalId: "TERM-OTHER" })],
    });
    expect(res.failed).toBe(1);
    expect(res.results[0]!.error).toContain("does not match");
  });

  it("marks replays as duplicates without re-crediting", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const wallet = seedWallet(42, 0);
    const rec = validRecord({ type: "wallet_topup", walletId: wallet.id });
    const caller = await terminalCaller();
    await caller.batchSync({ terminalId: "TERM-001", records: [rec] });
    const res = await caller.batchSync({ terminalId: "TERM-001", records: [rec] });
    expect(res.results[0]!.duplicate).toBe(true);
    expect(wallet.balanceKobo).toBe(50_000);
    expect(state.ledger).toHaveLength(1);
  });

  it("rejects batches over 200 records", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const caller = await terminalCaller();
    const records = Array.from({ length: 201 }, () => validRecord());
    await expect(caller.batchSync({ terminalId: "TERM-001", records })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects batch sync from a revoked terminal", async () => {
    seedTerminal({ terminalId: "TERM-001", status: "revoked" });
    const caller = await terminalCaller();
    await expect(caller.batchSync({ terminalId: "TERM-001", records: [validRecord()] }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ── reverseTransaction ────────────────────────────────────────────────────────

describe("pos.reverseTransaction", () => {
  beforeEach(() => { resetState(); vi.clearAllMocks(); });

  async function recordTopup(amountKobo: number, walletId: number) {
    const termCaller = (await getPosRouter()).createCaller(makeTerminalCtx(terminalToken("TERM-001")));
    const rec = validRecord({ type: "wallet_topup", amountKobo, walletId });
    await termCaller.recordTransaction(rec);
    return rec;
  }

  it("reverses an approved top-up with an offsetting ledger entry", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const wallet = seedWallet(42, 0);
    const rec = await recordTopup(50_000, wallet.id);
    expect(wallet.balanceKobo).toBe(50_000);

    const admin = (await getPosRouter()).createCaller(makeUserCtx("admin", 1));
    const res = await admin.reverseTransaction({ txnUid: rec.txnUid, reason: "double charge at booth" });
    expect(res.status).toBe("reversed");
    expect(res.walletDebit).toMatchObject({ status: "debited", newBalanceKobo: 0 });
    expect(wallet.balanceKobo).toBe(0);
    expect(state.txns[0]!.status).toBe("reversed");
    expect(state.ledger.map((l) => l.externalRef)).toEqual([`POS-${rec.txnUid}`, `POS-REV-${rec.txnUid}`]);
    expect(mockWriteAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "pos.txn.reverse" }));
  });

  it("reversal replay is idempotent", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const wallet = seedWallet(42, 0);
    const rec = await recordTopup(50_000, wallet.id);
    const admin = (await getPosRouter()).createCaller(makeUserCtx("admin", 1));
    await admin.reverseTransaction({ txnUid: rec.txnUid, reason: "double charge at booth" });
    const again = await admin.reverseTransaction({ txnUid: rec.txnUid, reason: "double charge at booth" });
    expect(again.duplicate).toBe(true);
    expect(state.ledger).toHaveLength(2);
    expect(wallet.balanceKobo).toBe(0);
  });

  it("requires a second admin for reversals over ₦50,000 (4-eyes)", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const wallet = seedWallet(42, 0);
    const rec = await recordTopup(6_000_000, wallet.id); // ₦60,000
    const admin = (await getPosRouter()).createCaller(makeUserCtx("admin", 1));

    await expect(admin.reverseTransaction({ txnUid: rec.txnUid, reason: "large erroneous credit" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    // requester cannot self-approve
    await expect(admin.reverseTransaction({ txnUid: rec.txnUid, reason: "large erroneous credit", secondAdminId: 1 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    // second approver must be an admin
    await expect(admin.reverseTransaction({ txnUid: rec.txnUid, reason: "large erroneous credit", secondAdminId: 4 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    // still not reversed after failed attempts
    expect(state.txns[0]!.status).toBe("approved");

    const ok = await admin.reverseTransaction({ txnUid: rec.txnUid, reason: "large erroneous credit", secondAdminId: 2 });
    expect(ok.status).toBe("reversed");
    expect(wallet.balanceKobo).toBe(0);
  });

  it("rejects reversal of a non-approved transaction and unknown txnUid", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const admin = (await getPosRouter()).createCaller(makeUserCtx("admin", 1));
    await expect(admin.reverseTransaction({ txnUid: randomUUID(), reason: "no such transaction" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });

    // force a pending txn via failed credit
    const termCaller = (await getPosRouter()).createCaller(makeTerminalCtx(terminalToken("TERM-001")));
    const rec = validRecord({ type: "wallet_topup", walletId: 999 });
    await expect(termCaller.recordTransaction(rec)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(admin.reverseTransaction({ txnUid: rec.txnUid, reason: "pending cannot reverse" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("reverses a toll_payment without touching any wallet", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const termCaller = (await getPosRouter()).createCaller(makeTerminalCtx(terminalToken("TERM-001")));
    const rec = validRecord({ type: "toll_payment" });
    await termCaller.recordTransaction(rec);
    const admin = (await getPosRouter()).createCaller(makeUserCtx("admin", 1));
    const res = await admin.reverseTransaction({ txnUid: rec.txnUid, reason: "card charged twice" });
    expect(res.status).toBe("reversed");
    expect(res.walletDebit).toBeNull();
    expect(state.ledger).toHaveLength(0);
  });

  it("requires admin role", async () => {
    seedTerminal({ terminalId: "TERM-001" });
    const operator = (await getPosRouter()).createCaller(makeUserCtx("operator", 3));
    await expect(operator.reverseTransaction({ txnUid: randomUUID(), reason: "not allowed here" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ── listTransactions / terminalDailySummary ───────────────────────────────────

describe("pos.listTransactions", () => {
  beforeEach(() => { resetState(); vi.clearAllMocks(); });

  async function seedTxns() {
    const t1 = seedTerminal({ terminalId: "TERM-001", plazaId: "PLAZA-1" });
    const t2 = seedTerminal({ terminalId: "TERM-002", plazaId: "PLAZA-2" });
    const now = new Date();
    const mk = (terminalId: number, status: string, type: string, occurredAt: Date): FakeTxn => ({
      id: state.nextTxnId++, txnUid: randomUUID(), terminalId, type, amountKobo: 25_000,
      cardLast4: "1234", cardScheme: "verve", rrn: "R1", stan: "S1", status,
      walletId: null, laneEventId: null, occurredAt, syncedAt: occurredAt,
    });
    state.txns.push(
      mk(t1.id, "approved", "toll_payment", now),
      mk(t1.id, "approved", "wallet_topup", now),
      mk(t1.id, "reversed", "toll_payment", new Date(now.getTime() - 2 * 86400_000)),
      mk(t2.id, "approved", "toll_payment", now),
    );
  }

  it("filters by terminal code, status and type", async () => {
    await seedTxns();
    const caller = (await getPosRouter()).createCaller(makeUserCtx("operator", 3));

    const all = await caller.listTransactions({ limit: 50, offset: 0 });
    expect(all.total).toBe(4);

    const t1Only = await caller.listTransactions({ limit: 50, offset: 0, terminalId: "TERM-001" });
    expect(t1Only.total).toBe(3);
    expect(t1Only.items.every((i) => (i as { terminalId: string }).terminalId === "TERM-001")).toBe(true);

    const reversed = await caller.listTransactions({ limit: 50, offset: 0, status: "reversed" });
    expect(reversed.total).toBe(1);

    const topups = await caller.listTransactions({ limit: 50, offset: 0, type: "wallet_topup" });
    expect(topups.total).toBe(1);

    const plaza2 = await caller.listTransactions({ limit: 50, offset: 0, plazaId: "PLAZA-2" });
    expect(plaza2.total).toBe(1);
  });

  it("paginates and applies a date range", async () => {
    await seedTxns();
    const caller = (await getPosRouter()).createCaller(makeUserCtx("admin", 1));
    const page = await caller.listTransactions({ limit: 2, offset: 0 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(4);

    const todayOnly = await caller.listTransactions({
      limit: 50, offset: 0, from: new Date(Date.now() - 3600_000),
    });
    expect(todayOnly.total).toBe(3);
  });

  it("rejects plain users", async () => {
    const caller = (await getPosRouter()).createCaller(makeUserCtx("user", 4));
    await expect(caller.listTransactions({ limit: 50, offset: 0 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("pos.terminalDailySummary", () => {
  beforeEach(() => { resetState(); vi.clearAllMocks(); });

  it("aggregates per-terminal today totals by type and status", async () => {
    const t1 = seedTerminal({ terminalId: "TERM-001", plazaId: "PLAZA-1" });
    const t2 = seedTerminal({ terminalId: "TERM-002", plazaId: "PLAZA-2" });
    const today = new Date();
    const yesterday = new Date(Date.now() - 2 * 86400_000);
    const mk = (terminalId: number, type: string, status: string, amountKobo: number, at: Date): FakeTxn => ({
      id: state.nextTxnId++, txnUid: randomUUID(), terminalId, type, amountKobo,
      cardLast4: "1234", cardScheme: "verve", rrn: "R", stan: "S", status,
      walletId: null, laneEventId: null, occurredAt: at, syncedAt: at,
    });
    state.txns.push(
      mk(t1.id, "toll_payment", "approved", 20_000, today),
      mk(t1.id, "toll_payment", "approved", 30_000, today),
      mk(t1.id, "wallet_topup", "approved", 100_000, today),
      mk(t1.id, "wallet_topup", "pending", 50_000, today),
      mk(t1.id, "toll_payment", "approved", 99_900, yesterday), // excluded
      mk(t2.id, "toll_payment", "approved", 10_000, today),
    );

    const caller = (await getPosRouter()).createCaller(makeUserCtx("operator", 3));
    const res = await caller.terminalDailySummary({});
    expect(res.terminals).toHaveLength(2);

    const s1 = res.terminals.find((s) => s.terminalId === "TERM-001")!;
    expect(s1.totalCount).toBe(4);
    expect(s1.totalKobo).toBe(200_000);
    expect(s1.byType["toll_payment"]).toEqual({ count: 2, totalKobo: 50_000 });
    expect(s1.byType["wallet_topup"]).toEqual({ count: 2, totalKobo: 150_000 });
    expect(s1.byStatus["pending"]).toEqual({ count: 1, totalKobo: 50_000 });

    const s2 = res.terminals.find((s) => s.terminalId === "TERM-002")!;
    expect(s2.totalKobo).toBe(10_000);

    // terminal filter
    const only = await caller.terminalDailySummary({ terminalId: "TERM-002" });
    expect(only.terminals).toHaveLength(1);
    expect(only.terminals[0]!.terminalId).toBe("TERM-002");
  });
});
