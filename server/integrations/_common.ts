/**
 * Shared plumbing for every server/integrations module.
 *
 * Design contract (applies to all modules in this directory):
 *  - Typed env via zod. Missing env  ⇒ module DISABLED, log once, never crash.
 *  - Lazy connect: no network I/O at import time.
 *  - Optional dependencies are loaded with a non-literal dynamic import so the
 *    server bundles/boots even when the package is not installed.
 *  - Retry with exponential backoff + jitter for transient connect failures.
 */

import { z } from "zod";

export { z };

/** Minimal structural logger so modules never hard-depend on a logging lib. */
export interface Logger {
  info: (msg: string, ...meta: unknown[]) => void;
  warn: (msg: string, ...meta: unknown[]) => void;
  error: (msg: string, ...meta: unknown[]) => void;
}

export const consoleLogger: Logger = {
  info: (m, ...x) => console.log(m, ...x),
  warn: (m, ...x) => console.warn(m, ...x),
  error: (m, ...x) => console.error(m, ...x),
};

const loggedOnce = new Set<string>();

/** Log a message exactly once per key per process (used for "disabled" notices). */
export function logOnce(key: string, level: keyof Logger, msg: string, logger: Logger = consoleLogger): void {
  if (loggedOnce.has(key)) return;
  loggedOnce.add(key);
  logger[level](msg);
}

/** Reset the log-once registry — for tests only. */
export function _resetLogOnce(): void {
  loggedOnce.clear();
}

/**
 * Parse env for a module. Returns null when validation fails or required vars
 * are absent; the caller treats null as "integration disabled".
 */
export function parseEnvOrNull<S extends z.ZodType>(
  schema: S,
  raw: Record<string, string | undefined>,
  moduleName: string,
  logger: Logger = consoleLogger,
): z.output<S> | null {
  const result = schema.safeParse(raw);
  if (!result.success) {
    logOnce(
      `env:${moduleName}`,
      "warn",
      `[${moduleName}] integration disabled — env incomplete/invalid: ${result.error.issues
        .map((i) => i.path.join("."))
        .join(", ")}`,
      logger,
    );
    return null;
  }
  return result.data;
}

/** True when a zod-optional env string is present and non-empty. */
export function present(v: string | undefined | null): v is string {
  return typeof v === "string" && v.length > 0;
}

export interface RetryOptions {
  attempts?: number; // total attempts (default 4)
  baseDelayMs?: number; // default 250
  maxDelayMs?: number; // default 5000
  logger?: Logger;
  label?: string;
}

/**
 * Retry an async operation with exponential backoff and full jitter.
 * Non-transient errors should be thrown as `FatalError` to skip retries.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 4, baseDelayMs = 250, maxDelayMs = 5000, logger = consoleLogger, label = "op" } = opts;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof FatalError) throw err.cause ?? err;
      if (attempt === attempts) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jittered = Math.random() * delay;
      logger.warn(`[retry] ${label} failed (attempt ${attempt}/${attempts}), retrying in ${Math.round(jittered)}ms`);
      await sleep(jittered);
    }
  }
  throw lastErr;
}

/** Throw this to abort retry loops immediately (auth failures, bad config…). */
export class FatalError extends Error {
  constructor(public cause?: unknown) {
    super("fatal");
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Dynamically import an OPTIONAL npm package. Returns null (and logs once)
 * when the package is not installed, so the host app never crashes on a
 * missing optional dependency. The specifier is intentionally non-literal so
 * bundlers do not try to resolve it at build time.
 */
export async function importOptional<T = unknown>(
  packageName: string,
  moduleName: string,
  logger: Logger = consoleLogger,
): Promise<T | null> {
  try {
    const spec: string = packageName;
    return (await import(spec)) as T;
  } catch {
    logOnce(
      `pkg:${moduleName}`,
      "warn",
      `[${moduleName}] optional package "${packageName}" not installed — integration disabled. Install it to enable.`,
      logger,
    );
    return null;
  }
}

/** Standard health result shape returned by every module's *Health() fn. */
export interface IntegrationHealth {
  enabled: boolean;
  ok: boolean;
  latencyMs?: number;
  detail?: string;
  error?: string;
}

export const DISABLED_HEALTH: IntegrationHealth = { enabled: false, ok: true, detail: "env not set; integration disabled" };
