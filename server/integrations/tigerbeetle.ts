/**
 * TigerBeetle integration — authoritative double-entry ledger for wallets.
 *
 * AUDIT CONTEXT: today db.ts stores "tigerBeetleId" strings that are generated
 * locally (nanoid-style) with no real ledger behind them (audit grade 0). This
 * module replaces that fakery with a real client, but is DISABLED until
 * TIGERBEETLE_ADDRESSES is set — the postgres wallet_accounts table remains the
 * system of record until the cutover runbook is executed.
 *
 * ENABLE WHEN: wallet transaction volume makes postgres row-lock contention or
 * audit-trail gaps painful, or before any external money movement (refunds to
 * bank) where double-entry correctness is non-negotiable.
 *
 * Ledger model (all amounts in kobo, ledger id 1 = NGN-kobo):
 *   user_wallet:<userId>        — one TB account per user (debits_normal=false)
 *   provider_clearing:<name>    — paystack | flutterwave | interswitch float
 *   operator_fees               — platform revenue account
 *   refunds_holding             — liability account for refunds in flight
 *
 * IDEMPOTENCY: transfer IDs are derived deterministically from the provider
 * reference, so webhook retries produce TB `exists` results which we treat as
 * success. Never regenerate an ID from randomness.
 *
 * Compose profile: `core`. Env: TIGERBEETLE_ADDRESSES (e.g. "3000" or
 * "10.0.0.5:3000,10.0.0.6:3000" for a replica set), TIGERBEETLE_CLUSTER_ID.
 */

import { createHash } from "node:crypto";
import {
  DISABLED_HEALTH,
  importOptional,
  logOnce,
  parseEnvOrNull,
  withRetry,
  z,
  type IntegrationHealth,
} from "./_common";

const envSchema = z.object({
  TIGERBEETLE_ADDRESSES: z.string().min(1),
  TIGERBEETLE_CLUSTER_ID: z.coerce.number().int().nonnegative().optional(),
});

type Env = z.output<typeof envSchema>;

// ── Structural types mirroring tigerbeetle-node (package optional) ──────────

export interface TbAccount {
  id: bigint;
  debits_pending: bigint;
  debits_posted: bigint;
  credits_pending: bigint;
  credits_posted: bigint;
  user_data_128: bigint;
  user_data_64: bigint;
  user_data_32: number;
  reserved: number;
  ledger: number;
  code: number;
  flags: number;
  timestamp: bigint;
}

export interface TbTransfer {
  id: bigint;
  debit_account_id: bigint;
  credit_account_id: bigint;
  amount: bigint;
  pending_id: bigint;
  user_data_128: bigint;
  user_data_64: bigint;
  user_data_32: number;
  reserved: number;
  timeout: number;
  ledger: number;
  code: number;
  flags: number;
  timestamp: bigint;
}

interface TbClient {
  createAccounts(accounts: TbAccount[]): Promise<Array<{ index: number; result: number }>>;
  createTransfers(transfers: TbTransfer[]): Promise<Array<{ index: number; result: number }>>;
  lookupAccounts(ids: bigint[]): Promise<TbAccount[]>;
  lookupTransfers(ids: bigint[]): Promise<TbTransfer[]>;
  destroy(): void;
}

interface TbModule {
  createClient(opts: { cluster_id: number | bigint; replica_addresses: string[] }): TbClient;
  CreateTransferError: Record<string, number>;
  CreateAccountError: Record<string, number>;
}

/** Cached enum tables from the loaded module (fall back to known 0.16.x values). */
let TB_TRANSFER_EXISTS = 36;
let TB_ACCOUNT_EXISTS = 22;
function cacheEnumCodes(mod: TbModule): void {
  if (mod.CreateTransferError && typeof mod.CreateTransferError["exists"] === "number") {
    TB_TRANSFER_EXISTS = mod.CreateTransferError["exists"];
  }
  if (mod.CreateAccountError && typeof mod.CreateAccountError["exists"] === "number") {
    TB_ACCOUNT_EXISTS = mod.CreateAccountError["exists"];
  }
}

/**
 * True only for the exact `exists` code (identical transfer already committed
 * — idempotent success). The `exists_with_different_*` family means a caller
 * reused a provider reference with mutated parameters: a real bug, never
 * swallowed.
 */
function isIdempotentExists(resultCode: number): boolean {
  return resultCode === TB_TRANSFER_EXISTS;
}

/** TB account flags */
const TB_ACCOUNT_HISTORY = 1 << 3; // AccountFlags.history

/** Ledger namespace: all platform money is ledger 1, unit = kobo. */
export const TB_LEDGER_NGN_KOBO = 1;

/** TB `code` field = transfer/account taxonomy. */
export const TB_CODES = {
  userWalletAccount: 100,
  providerClearingAccount: 101,
  operatorFeesAccount: 102,
  refundsHoldingAccount: 103,
  topUpTransfer: 200,
  tollChargeTransfer: 201,
  feeTransfer: 202,
  refundTransfer: 203,
} as const;

let _env: Env | null | undefined;
let _client: TbClient | null = null;
let _mod: TbModule | null = null;
let _connecting: Promise<TbClient | null> | null = null;

function env(): Env | null {
  if (_env === undefined) _env = parseEnvOrNull(envSchema, process.env, "TigerBeetle");
  return _env;
}

export function tigerBeetleEnabled(): boolean {
  return env() !== null;
}

/**
 * Deterministic 128-bit ID from a seed string (first 16 bytes of SHA-256,
 * little-endian u128 as bigint, clamped to non-zero). This is what makes
 * provider-webhook retries idempotent.
 */
export function tbId(seed: string): bigint {
  const digest = createHash("sha256").update(seed).digest();
  let id = 0n;
  for (let i = 15; i >= 0; i--) id = (id << 8n) | BigInt(digest[i]);
  return id === 0n ? 1n : id;
}

/** Account ID seeds — stable forever; changing them forks the ledger. */
export const ACCOUNT_SEEDS = {
  userWallet: (userId: number | string) => `account:user_wallet:${userId}`,
  providerClearing: (provider: "paystack" | "flutterwave" | "interswitch") => `account:provider_clearing:${provider}`,
  operatorFees: () => `account:operator_fees`,
  refundsHolding: () => `account:refunds_holding`,
} as const;

export function userWalletAccountId(userId: number | string): bigint {
  return tbId(ACCOUNT_SEEDS.userWallet(userId));
}

async function getClient(): Promise<TbClient | null> {
  const e = env();
  if (!e) return null;
  if (_client) return _client;
  if (_connecting) return _connecting;

  _connecting = (async () => {
    const mod = await importOptional<TbModule>("tigerbeetle-node", "TigerBeetle");
    if (!mod || typeof mod.createClient !== "function") return null;
    _mod = mod;
    cacheEnumCodes(mod);
    const addresses = e.TIGERBEETLE_ADDRESSES.split(",").map((a) => a.trim());
    try {
      return await withRetry(
        async () => {
          const client = mod.createClient({
            cluster_id: e.TIGERBEETLE_CLUSTER_ID ?? 0,
            replica_addresses: addresses,
          });
          // Probe: lookup a guaranteed-missing account to prove connectivity.
          await client.lookupAccounts([tbId("probe:connectivity")]);
          return client;
        },
        { label: "tigerbeetle-connect", attempts: 3 },
      );
    } catch (err) {
      logOnce("tb:fail", "warn", `[TigerBeetle] unreachable — wallet ops stay postgres-only (${err instanceof Error ? err.message : String(err)})`);
      return null;
    } finally {
      _connecting = null;
    }
  })().then((c) => {
    _client = c;
    return c;
  });
  return _connecting;
}

export async function tigerBeetleHealth(): Promise<IntegrationHealth> {
  if (!tigerBeetleEnabled()) return DISABLED_HEALTH;
  const started = Date.now();
  const client = await getClient();
  if (!client) return { enabled: true, ok: false, error: "client unavailable" };
  try {
    await client.lookupAccounts([tbId("probe:health")]);
    return { enabled: true, ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { enabled: true, ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

function zeroAccount(id: bigint, code: number): TbAccount {
  return {
    id,
    debits_pending: 0n,
    debits_posted: 0n,
    credits_pending: 0n,
    credits_posted: 0n,
    user_data_128: 0n,
    user_data_64: 0n,
    user_data_32: 0,
    reserved: 0,
    ledger: TB_LEDGER_NGN_KOBO,
    code,
    flags: TB_ACCOUNT_HISTORY,
    timestamp: 0n,
  };
}

/** Idempotently create the platform-level accounts (clearing, fees, refunds). */
export async function ensurePlatformAccounts(providers: Array<"paystack" | "flutterwave" | "interswitch"> = ["paystack", "flutterwave", "interswitch"]): Promise<boolean> {
  const client = await getClient();
  if (!client) return false;
  const accounts = [
    ...providers.map((p) => zeroAccount(tbId(ACCOUNT_SEEDS.providerClearing(p)), TB_CODES.providerClearingAccount)),
    zeroAccount(tbId(ACCOUNT_SEEDS.operatorFees()), TB_CODES.operatorFeesAccount),
    zeroAccount(tbId(ACCOUNT_SEEDS.refundsHolding()), TB_CODES.refundsHoldingAccount),
  ];
  const errors = await client.createAccounts(accounts);
  const fatal = errors.filter((e) => e.result !== TB_ACCOUNT_EXISTS);
  if (fatal.length > 0) {
    logOnce("tb:acct-err", "error", `[TigerBeetle] account creation errors: ${JSON.stringify(fatal)}`);
    return false;
  }
  return true;
}

/** Idempotently create a user's wallet account. */
export async function ensureUserWalletAccount(userId: number | string): Promise<bigint | null> {
  const client = await getClient();
  if (!client) return null;
  const id = userWalletAccountId(userId);
  const errors = await client.createAccounts([zeroAccount(id, TB_CODES.userWalletAccount)]);
  const fatal = errors.filter((e) => e.result !== TB_ACCOUNT_EXISTS);
  if (fatal.length > 0) {
    logOnce(`tb:user-acct:${userId}`, "error", `[TigerBeetle] wallet account creation failed for user ${userId}: ${JSON.stringify(fatal)}`);
    return null;
  }
  return id;
}

function zeroTransfer(partial: Pick<TbTransfer, "id" | "debit_account_id" | "credit_account_id" | "amount" | "code">): TbTransfer {
  return {
    pending_id: 0n,
    user_data_128: 0n,
    user_data_64: 0n,
    user_data_32: 0,
    reserved: 0,
    timeout: 0,
    ledger: TB_LEDGER_NGN_KOBO,
    flags: 0,
    timestamp: 0n,
    ...partial,
  };
}

export interface LedgerResult {
  /** true when posted (or already existed — idempotent success) */
  posted: boolean;
  transferId: string;
  /** true when the transfer already existed (retry-safe no-op) */
  duplicate?: boolean;
  error?: string;
}

async function postTransfer(transfer: TbTransfer): Promise<LedgerResult> {
  const client = await getClient();
  const transferId = transfer.id.toString(16).padStart(32, "0");
  if (!client) {
    return { posted: false, transferId, error: "tigerbeetle disabled/unavailable — caller must use postgres path" };
  }
  const errors = await client.createTransfers([transfer]);
  if (errors.length === 0) return { posted: true, transferId };
  const code = errors[0].result;
  if (isIdempotentExists(code)) return { posted: true, transferId, duplicate: true };
  const codeName = _mod ? Object.entries(_mod.CreateTransferError ?? {}).find(([, v]) => v === code)?.[0] : undefined;
  return {
    posted: false,
    transferId,
    error: `tigerbeetle createTransfers error ${codeName ?? `code ${code}`}${codeName?.startsWith("exists_with_different") ? " — idempotency violation: provider reference reused with different parameters" : ""}`,
  };
}

/**
 * Post a wallet top-up: provider_clearing:<provider> → user_wallet:<userId>.
 * Transfer ID is derived from the provider reference so Paystack/Flutterwave
 * webhook retries are exactly-once.
 */
export async function ledgerTopUp(
  userId: number | string,
  amountKobo: number | bigint,
  providerRef: string,
  provider: "paystack" | "flutterwave" | "interswitch" = "paystack",
): Promise<LedgerResult> {
  await ensureUserWalletAccount(userId);
  return postTransfer(
    zeroTransfer({
      id: tbId(`transfer:topup:${provider}:${providerRef}`),
      debit_account_id: tbId(ACCOUNT_SEEDS.providerClearing(provider)),
      credit_account_id: userWalletAccountId(userId),
      amount: BigInt(amountKobo),
      code: TB_CODES.topUpTransfer,
    }),
  );
}

/**
 * Post a toll charge: user_wallet → operator_fees (fee portion kept as a
 * separate linked transfer when feeKobo > 0). `chargeRef` must be unique per
 * charge attempt (e.g. wallet_transactions.id or plaza event id).
 */
export async function ledgerTollCharge(
  userId: number | string,
  amountKobo: number | bigint,
  chargeRef: string,
  opts: { plazaId?: string; feeKobo?: number | bigint } = {},
): Promise<LedgerResult> {
  const amount = BigInt(amountKobo);
  const fee = BigInt(opts.feeKobo ?? 0);
  if (fee < 0n || fee >= amount) {
    return { posted: false, transferId: "", error: "fee must be >= 0 and < amount" };
  }
  const main = await postTransfer(
    zeroTransfer({
      id: tbId(`transfer:toll:${chargeRef}`),
      debit_account_id: userWalletAccountId(userId),
      credit_account_id: tbId(ACCOUNT_SEEDS.operatorFees()),
      amount: amount - fee,
      code: TB_CODES.tollChargeTransfer,
    }),
  );
  if (!main.posted) return main;
  if (fee > 0n) {
    const feeResult = await postTransfer(
      zeroTransfer({
        id: tbId(`transfer:toll-fee:${chargeRef}`),
        debit_account_id: userWalletAccountId(userId),
        credit_account_id: tbId(ACCOUNT_SEEDS.operatorFees()),
        amount: fee,
        code: TB_CODES.feeTransfer,
      }),
    );
    if (!feeResult.posted && !feeResult.duplicate) {
      // Main leg posted; fee leg failed — surface for the reconciliation job.
      return { ...main, error: `fee leg failed: ${feeResult.error}` };
    }
  }
  return main;
}

/**
 * Post a refund: refunds_holding → user_wallet. The settlement leg
 * (provider → refunds_holding) is posted when the provider confirms payout.
 */
export async function ledgerRefund(
  userId: number | string,
  amountKobo: number | bigint,
  refundRef: string,
): Promise<LedgerResult> {
  await ensureUserWalletAccount(userId);
  return postTransfer(
    zeroTransfer({
      id: tbId(`transfer:refund:${refundRef}`),
      debit_account_id: tbId(ACCOUNT_SEEDS.refundsHolding()),
      credit_account_id: userWalletAccountId(userId),
      amount: BigInt(amountKobo),
      code: TB_CODES.refundTransfer,
    }),
  );
}

/** Available balance in kobo = credits_posted - debits_posted (liability-side account). */
export async function ledgerBalanceKobo(userId: number | string): Promise<bigint | null> {
  const client = await getClient();
  if (!client) return null;
  const accounts = await client.lookupAccounts([userWalletAccountId(userId)]);
  if (accounts.length === 0) return null;
  const a = accounts[0];
  return a.credits_posted - a.debits_posted;
}

export interface ReconciliationMismatch {
  userId: number | string;
  ledgerKobo: bigint;
  cachedKobo: bigint;
  driftKobo: bigint;
}

/**
 * Compare TigerBeetle balances against postgres-cached balances
 * (wallet_accounts.balanceKobo). The caller supplies cached rows (keeps this
 * module decoupled from drizzle schema). Feed mismatches into the drift
 * alerting path — see infra/runbooks/drift-alert-response.md.
 */
export async function reconcileBalances(
  cached: Array<{ userId: number | string; cachedBalanceKobo: number | bigint }>,
): Promise<{ checked: number; mismatches: ReconciliationMismatch[] } | null> {
  const client = await getClient();
  if (!client) return null;
  const ids = cached.map((c) => userWalletAccountId(c.userId));
  const accounts = await client.lookupAccounts(ids);
  const byId = new Map(accounts.map((a) => [a.id.toString(), a]));
  const mismatches: ReconciliationMismatch[] = [];
  for (const row of cached) {
    const a = byId.get(userWalletAccountId(row.userId).toString());
    if (!a) {
      mismatches.push({ userId: row.userId, ledgerKobo: 0n, cachedKobo: BigInt(row.cachedBalanceKobo), driftKobo: -BigInt(row.cachedBalanceKobo) });
      continue;
    }
    const ledger = a.credits_posted - a.debits_posted;
    const cachedKobo = BigInt(row.cachedBalanceKobo);
    if (ledger !== cachedKobo) {
      mismatches.push({ userId: row.userId, ledgerKobo: ledger, cachedKobo, driftKobo: ledger - cachedKobo });
    }
  }
  return { checked: cached.length, mismatches };
}

/** Graceful shutdown. */
export async function closeTigerBeetle(): Promise<void> {
  if (_client) {
    _client.destroy();
    _client = null;
  }
}
