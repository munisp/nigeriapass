/**
 * Mojaloop (FSPIOP) integration — PHASE 3 SKELETON. Not wired to any flow.
 *
 * NIGERIAN-PRODUCTION REALITY: domestic instant payment interop in Nigeria is
 * NIBSS NIP (NIBSS Instant Payments), which is NOT Mojaloop-based. Mojaloop
 * matters only if NigerianPass expands into a regional scheme (e.g. a West
 * African toll/interop corridor) or joins a Mojaloop-based switch. Do not
 * enable this for the domestic launch.
 *
 * Dev simulation uses mojaloop/ml-testing-toolkit (compose profile `interop`),
 * which emulates a counterparty DFSP — a full hub is 15+ services and out of
 * scope for local dev.
 *
 * Env: MOJALOOP_BASE_URL (e.g. http://localhost:5050), MOJALOOP_DFSP_ID.
 */

import { DISABLED_HEALTH, logOnce, parseEnvOrNull, withRetry, z, type IntegrationHealth } from "./_common";

const envSchema = z.object({
  MOJALOOP_BASE_URL: z.string().min(1),
  MOJALOOP_DFSP_ID: z.string().min(1).optional(),
});

type Env = z.output<typeof envSchema>;

let _env: Env | null | undefined;

function env(): Env | null {
  if (_env === undefined) _env = parseEnvOrNull(envSchema, process.env, "Mojaloop");
  return _env;
}

export function mojaloopEnabled(): boolean {
  return env() !== null;
}

export const FSPIOP_HEADERS = {
  parties: "application/vnd.interoperability.parties+json;version=1.0",
  quotes: "application/vnd.interoperability.quotes+json;version=1.0",
  transfers: "application/vnd.interoperability.transfers+json;version=1.0",
} as const;

function dfspId(): string {
  return env()?.MOJALOOP_DFSP_ID ?? "nigerianpass";
}

async function fspiopRequest(path: string, opts: { method: string; resource: keyof typeof FSPIOP_HEADERS; body?: unknown }): Promise<Record<string, unknown> | null> {
  const e = env();
  if (!e) return null;
  const base = e.MOJALOOP_BASE_URL.replace(/\/$/, "");
  const contentType = FSPIOP_HEADERS[opts.resource];
  const res = await fetch(`${base}${path}`, {
    method: opts.method,
    headers: {
      "content-type": contentType,
      accept: contentType,
      "fspiop-source": dfspId(),
      "fspiop-destination": "switch",
      date: new Date().toUTCString(),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`FSPIOP ${opts.method} ${path} HTTP ${res.status}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/**
 * Party lookup (GET /parties/{idType}/{id}) — resolves an MSISDN or account
 * alias to a counterparty DFSP. Async in real FSPIOP (callback to
 * PUT /parties/{idType}/{id}); the testing toolkit answers synchronously.
 */
export async function lookupParty(idType: "MSISDN" | "ALIAS" | "IBAN", id: string): Promise<Record<string, unknown> | null> {
  if (!mojaloopEnabled()) return null;
  try {
    return await withRetry(() => fspiopRequest(`/parties/${idType}/${encodeURIComponent(id)}`, { method: "GET", resource: "parties" }), {
      label: "mojaloop-parties",
      attempts: 2,
    });
  } catch (err) {
    logOnce("moja:party", "warn", `[Mojaloop] party lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Quote request (POST /quotes) — fee/commission discovery before a transfer.
 * Amounts are decimal strings in FSPIOP; convert kobo → naira at the boundary.
 */
export async function requestQuote(opts: {
  transactionId: string; // UUID
  payeeFsp: string;
  payerMsisdn: string;
  payeeMsisdn: string;
  amountKobo: number;
  currency?: string; // default NGN
}): Promise<Record<string, unknown> | null> {
  if (!mojaloopEnabled()) return null;
  const body = {
    transactionId: opts.transactionId,
    payer: { partyIdInfo: { partyIdType: "MSISDN", partyIdentifier: opts.payerMsisdn, fspId: dfspId() } },
    payee: { partyIdInfo: { partyIdType: "MSISDN", partyIdentifier: opts.payeeMsisdn, fspId: opts.payeeFsp } },
    amountType: "SEND",
    amount: { currency: opts.currency ?? "NGN", amount: (opts.amountKobo / 100).toFixed(2) },
    transactionType: { scenario: "TRANSFER", initiator: "PAYER", initiatorType: "CONSUMER" },
  };
  try {
    return await withRetry(() => fspiopRequest("/quotes", { method: "POST", resource: "quotes", body }), { label: "mojaloop-quotes", attempts: 2 });
  } catch (err) {
    logOnce("moja:quote", "warn", `[Mojaloop] quote failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Transfer prepare (POST /transfers) — commits to a quoted transfer. In a real
 * hub the fulfilment arrives via PUT /transfers/{id} callback carrying the
 * ILP fulfilment; settlement is hub-managed.
 */
export async function prepareTransfer(opts: {
  transferId: string; // UUID
  quoteId: string;
  ilpPacket: string;
  condition: string;
  amountKobo: number;
  currency?: string;
  payerFsp?: string;
  payeeFsp: string;
  expiration: string; // ISO-8601
}): Promise<Record<string, unknown> | null> {
  if (!mojaloopEnabled()) return null;
  const body = {
    transferId: opts.transferId,
    payerFsp: opts.payerFsp ?? dfspId(),
    payeeFsp: opts.payeeFsp,
    amount: { currency: opts.currency ?? "NGN", amount: (opts.amountKobo / 100).toFixed(2) },
    ilpPacket: opts.ilpPacket,
    condition: opts.condition,
    expiration: opts.expiration,
    extensionList: { extension: [{ key: "quoteId", value: opts.quoteId }] },
  };
  try {
    return await withRetry(() => fspiopRequest("/transfers", { method: "POST", resource: "transfers", body }), {
      label: "mojaloop-transfers",
      attempts: 2,
    });
  } catch (err) {
    logOnce("moja:transfer", "warn", `[Mojaloop] transfer prepare failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function mojaloopHealth(): Promise<IntegrationHealth> {
  if (!mojaloopEnabled()) return DISABLED_HEALTH;
  const e = env();
  const started = Date.now();
  try {
    // ml-testing-toolkit admin API health endpoint
    const res = await fetch(`${e!.MOJALOOP_BASE_URL.replace(/:\d+$/, ":4040")}/api/health`, { signal: AbortSignal.timeout(3000) });
    return { enabled: true, ok: res.ok, latencyMs: Date.now() - started, detail: "phase-3 dev simulation" };
  } catch (err) {
    return { enabled: true, ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}
