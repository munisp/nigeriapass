/**
 * Fluvio integration — DISABLED BY DEFAULT, note-driven module.
 *
 * WHEN TO PREFER FLUVIO OVER KAFKA:
 *  - Edge deployments: toll plazas running on-prem boxes with intermittent
 *    uplinks — Fluvio's SPU + SmartModule design fits store-and-forward at the
 *    edge better than Kafka's JVM-era broker model.
 *  - A Rust-heavy team: Fluvio is Rust-native; SmartModules (WASM) let you do
 *    in-stream filtering without a Flink/ksqlDB tier.
 * Otherwise use kafka.ts (Redpanda) — it is the default event backbone here.
 *
 * NOTE ON DEPLOYMENT: Fluvio is cluster-managed (SC + SPUs), not a single
 * container. The compose `graph` profile runs a local dev cluster via the
 * fluvio CLI image; staging/prod should use the Helm chart on k8s. This module
 * therefore wraps the FLUVIO CLI rather than a socket client, matching how the
 * platform would interact at the edge (shell-friendly, zero npm deps).
 *
 * Env: FLUVIO_ENABLED=true, optional FLUVIO_PROFILE (cluster profile name).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DISABLED_HEALTH, logOnce, parseEnvOrNull, z, type IntegrationHealth } from "./_common";

const execFileAsync = promisify(execFile);

const envSchema = z.object({
  FLUVIO_ENABLED: z.literal("true"),
  FLUVIO_PROFILE: z.string().min(1).optional(),
});

type Env = z.output<typeof envSchema>;

let _env: Env | null | undefined;

function env(): Env | null {
  if (_env === undefined) _env = parseEnvOrNull(envSchema, process.env, "Fluvio");
  return _env;
}

export function fluvioEnabled(): boolean {
  return env() !== null;
}

export const FLUVIO_TOPICS = {
  tollEdgeEvents: "toll.edge.events", // plaza edge boxes → core
  deviceTelemetry: "device.telemetry",
} as const;

async function runFluvio(args: string[]): Promise<string> {
  const profileArgs = env()?.FLUVIO_PROFILE ? ["--profile", env()!.FLUVIO_PROFILE!] : [];
  const { stdout } = await execFileAsync("fluvio", [...profileArgs, ...args], {
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Produce a single record. The payload is piped via stdin through a shell so
 * arbitrary JSON is safe; topic/key are validated to block shell injection.
 */
export async function fluvioProduce(topic: string, key: string, payload: unknown): Promise<boolean> {
  if (!fluvioEnabled()) return false;
  if (!/^[a-z0-9._-]{1,128}$/i.test(topic) || !/^[\x20-\x7e]{0,256}$/.test(key)) {
    throw new Error("fluvioProduce: invalid topic or key characters");
  }
  try {
    // Payload travels in an env var + printf so no JSON can escape the pipe.
    await execFileAsync("sh", ["-c", `printf '%s' "$FLUVIO_PAYLOAD" | fluvio produce "${topic}" --key "${key}"`], {
      timeout: 10_000,
      env: { ...process.env, FLUVIO_PAYLOAD: JSON.stringify(payload) },
    });
    return true;
  } catch (err) {
    logOnce("fluvio:produce", "warn", `[Fluvio] produce failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * Consume records from a topic (one-shot batch read with a byte offset).
 * For streaming, callers should run `fluvio consume -d` as a supervised
 * subprocess at the edge; this helper is for backfill/debug.
 */
export async function fluvioConsumeBatch(topic: string, opts: { offset?: number; maxBytes?: number } = {}): Promise<string[] | null> {
  if (!fluvioEnabled()) return null;
  const args = ["consume", topic, "--offset", String(opts.offset ?? 0), "--maxbytes", String(opts.maxBytes ?? 1_000_000)];
  try {
    const stdout = await runFluvio(args);
    return stdout.split("\n").filter((line) => line.trim().length > 0);
  } catch (err) {
    logOnce("fluvio:consume", "warn", `[Fluvio] consume failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Create a topic if missing. */
export async function fluvioEnsureTopic(topic: string, partitions = 1): Promise<boolean> {
  if (!fluvioEnabled()) return false;
  try {
    await runFluvio(["topic", "create", topic, "--partitions", String(partitions)]);
    return true;
  } catch {
    return false; // "topic already exists" surfaces as non-zero exit
  }
}

export async function fluvioHealth(): Promise<IntegrationHealth> {
  if (!fluvioEnabled()) return DISABLED_HEALTH;
  const started = Date.now();
  try {
    const stdout = await runFluvio(["cluster", "status"]);
    const ok = /ok|running|sc/i.test(stdout);
    return { enabled: true, ok, latencyMs: Date.now() - started, detail: stdout.trim().slice(0, 120) };
  } catch (err) {
    return { enabled: true, ok: false, latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}
