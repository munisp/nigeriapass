/**
 * NFC Batch Provisioning Router
 * ================================
 * Allows operators to provision multiple NFC tags in a single request by
 * uploading a CSV of (tagId, vehicleRef) pairs. The server derives the
 * per-tag AES-128 key using HKDF-SHA256 for each entry and returns a
 * downloadable CSV of results.
 *
 * CSV input format (header required):
 *   tagId,vehicleRef
 *   NFC-001-ABCD,VEH-LAG001
 *   NFC-002-EFGH,VEH-LAG002
 *
 * CSV output format:
 *   tagId,vehicleRef,refId,keyHex,signature,status,error
 */
import { z } from "zod";
import { router, adminProcedure } from "../_core/trpc.js";
import crypto from "crypto";
import { ENV } from "../_core/env.js";
import {
  createNfcBatchJob,
  updateNfcBatchJob,
  getNfcBatchJob,
  listNfcBatchJobs,
} from "../db.js";
import { notifyOwner } from "../_core/notification.js";

// ── HKDF helpers (same as nfc.ts) ─────────────────────────────────────────────

function deriveTagKey(tagId: string): string {
  const masterSecret = ENV.nfcMasterSecret || "NigerianPass-Server-Master-Secret-v1";
  const ikm = Buffer.from(masterSecret, "utf8");
  const salt = Buffer.from("NigerianPass-NFC-Salt-v1", "utf8");
  const info = Buffer.from(`tag:${tagId}`, "utf8");
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  const t1 = crypto.createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest();
  return t1.slice(0, 16).toString("hex").toUpperCase();
}

function signNdef(tagId: string, vehicleRef: string, keyHex: string): string {
  const payload = JSON.stringify({ tid: tagId, vref: vehicleRef, k: keyHex, ts: Date.now() });
  return crypto.createHmac("sha256", keyHex).update(payload).digest("hex").slice(0, 16).toUpperCase();
}

// ── CSV parser ────────────────────────────────────────────────────────────────

interface CsvRow {
  tagId: string;
  vehicleRef: string;
}

function parseCsv(csv: string): CsvRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("CSV must have a header row and at least one data row");
  const header = lines[0].toLowerCase().replace(/\s/g, "");
  if (!header.includes("tagid") || !header.includes("vehicleref")) {
    throw new Error("CSV header must contain 'tagId' and 'vehicleRef' columns");
  }
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(",").map(p => p.trim().replace(/^"|"$/g, ""));
    if (parts.length < 2) throw new Error(`Line ${i + 1}: expected 2 columns, got ${parts.length}`);
    const tagId = parts[0].toUpperCase().replace(/[^A-Z0-9\-_]/g, "");
    const vehicleRef = parts[1];
    if (tagId.length < 6 || tagId.length > 64) {
      throw new Error(`Line ${i + 1}: tagId '${parts[0]}' must be 6-64 alphanumeric characters`);
    }
    if (!vehicleRef || vehicleRef.length < 3 || vehicleRef.length > 64) {
      throw new Error(`Line ${i + 1}: vehicleRef '${vehicleRef}' must be 3-64 characters`);
    }
    rows.push({ tagId, vehicleRef });
  }
  if (rows.length === 0) throw new Error("CSV contains no valid data rows");
  if (rows.length > 500) throw new Error("Batch size limit is 500 tags per job");
  return rows;
}

// ── CSV serializer ────────────────────────────────────────────────────────────

function serializeCsvResults(results: Array<{
  tagId: string;
  vehicleRef: string;
  refId?: string;
  keyHex?: string;
  signature?: string;
  status: string;
  error?: string;
}>): string {
  const header = "tagId,vehicleRef,refId,keyHex,signature,status,error";
  const rows = results.map(r =>
    [
      r.tagId,
      r.vehicleRef,
      r.refId ?? "",
      r.keyHex ?? "",
      r.signature ?? "",
      r.status,
      r.error ?? "",
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")
  );
  return [header, ...rows].join("\n");
}

// ── Router ─────────────────────────────────────────────────────────────────────

export const nfcBatchRouter = router({
  /**
   * Submit a batch provisioning job.
   * Accepts CSV text with tagId,vehicleRef columns (max 500 rows).
   * Processes synchronously and returns results + downloadable CSV.
   */
  submitBatch: adminProcedure
    .input(z.object({
      csvContent: z.string().min(10).max(500_000),
    }))
    .mutation(async ({ ctx, input }) => {
      const startedAt = Date.now();

      let rows: CsvRow[];
      try {
        rows = parseCsv(input.csvContent);
      } catch (err) {
        throw new Error(`CSV parse error: ${(err as Error).message}`);
      }

      const jobRef = `BATCH-${Date.now().toString(36).toUpperCase()}`;
      await createNfcBatchJob({
        jobRef,
        submittedBy: ctx.user.id,
        totalTags: rows.length,
        status: "processing",
        results: [],
        provisioned: 0,
        failed: 0,
        durationMs: 0,
      });

      const results: Array<{
        tagId: string;
        vehicleRef: string;
        refId?: string;
        keyHex?: string;
        keyHexPrefix?: string;
        signature?: string;
        status: string;
        error?: string;
      }> = [];

      let provisioned = 0;
      let failed = 0;

      for (const row of rows) {
        try {
          const keyHex = deriveTagKey(row.tagId);
          const signature = signNdef(row.tagId, row.vehicleRef, keyHex);
          const refId = `NFC-${row.tagId.slice(0, 8)}-${Date.now().toString(36).toUpperCase()}`;
          results.push({
            tagId: row.tagId,
            vehicleRef: row.vehicleRef,
            refId,
            keyHex,
            keyHexPrefix: keyHex.slice(0, 8) + "...",
            signature,
            status: "ok",
          });
          provisioned++;
        } catch (err) {
          results.push({
            tagId: row.tagId,
            vehicleRef: row.vehicleRef,
            status: "error",
            error: (err as Error).message,
          });
          failed++;
        }
      }

      const durationMs = Date.now() - startedAt;
      const status = failed === rows.length ? "failed" : "completed";

      // Persist results — store keyHexPrefix only, never full key
      const dbResults = results.map(r => ({
        tagId: r.tagId,
        vehicleRef: r.vehicleRef,
        refId: r.refId,
        keyHexPrefix: r.keyHexPrefix,
        error: r.error,
      }));

      await updateNfcBatchJob(jobRef, {
        status,
        provisioned,
        failed,
        results: dbResults,
        durationMs,
        completedAt: new Date(),
      });

      // Notify the platform owner that the batch job has completed
      await notifyOwner({
        title: `NFC Batch ${status === "completed" ? "Completed" : "Failed"} — ${jobRef}`,
        content: `Batch provisioning job ${jobRef} finished in ${(durationMs / 1000).toFixed(1)}s.\n` +
          `Provisioned: ${provisioned} tags | Failed: ${failed} tags | Total: ${rows.length} tags.` +
          (failed > 0 ? `\n\n${failed} tag(s) failed — download the CSV from the admin portal for details.` : ""),
      }).catch(() => { /* non-fatal — notification failure should not block the response */ });

      // Build downloadable CSV (includes full keyHex for writing to physical tags)
      const csvOutput = serializeCsvResults(results.map(r => ({
        tagId: r.tagId,
        vehicleRef: r.vehicleRef,
        refId: r.refId,
        keyHex: r.keyHex,
        signature: r.signature,
        status: r.status,
        error: r.error,
      })));

      return {
        jobRef,
        totalTags: rows.length,
        provisioned,
        failed,
        durationMs,
        status,
        csvOutput,
        results: results.map(r => ({
          tagId: r.tagId,
          vehicleRef: r.vehicleRef,
          refId: r.refId,
          keyHexPrefix: r.keyHexPrefix,
          signature: r.signature,
          status: r.status,
          error: r.error,
        })),
      };
    }),

  /**
   * Get a specific batch job by reference.
   */
  getJob: adminProcedure
    .input(z.object({ jobRef: z.string() }))
    .query(async ({ input }) => {
      const job = await getNfcBatchJob(input.jobRef);
      if (!job) throw new Error(`Batch job ${input.jobRef} not found`);
      return job;
    }),

  /**
   * List recent batch jobs (admin only, last 50).
   */
  listJobs: adminProcedure
    .query(async () => {
      return listNfcBatchJobs(50);
    }),
});
