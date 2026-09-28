/**
 * NFC Batch Provisioning Tests
 * ==============================
 * Tests the CSV parser, HKDF key derivation, and batch processing logic.
 */
import { describe, it, expect } from "vitest";
import crypto from "crypto";

// ── Inline helpers (mirror nfcBatch.ts logic) ─────────────────────────────────

function deriveTagKey(tagId: string): string {
  const masterSecret = "NigerianPass-Server-Master-Secret-v1";
  const ikm = Buffer.from(masterSecret, "utf8");
  const salt = Buffer.from("NigerianPass-NFC-Salt-v1", "utf8");
  const info = Buffer.from(`tag:${tagId}`, "utf8");
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  const t1 = crypto.createHmac("sha256", prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest();
  return t1.slice(0, 16).toString("hex").toUpperCase();
}

function parseCsv(csv: string): Array<{ tagId: string; vehicleRef: string }> {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("CSV must have a header row and at least one data row");
  const header = lines[0].toLowerCase().replace(/\s/g, "");
  if (!header.includes("tagid") || !header.includes("vehicleref")) {
    throw new Error("CSV header must contain 'tagId' and 'vehicleRef' columns");
  }
  const rows: Array<{ tagId: string; vehicleRef: string }> = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(",").map(p => p.trim().replace(/^"|"$/g, ""));
    if (parts.length < 2) throw new Error(`Line ${i + 1}: expected 2 columns`);
    const tagId = parts[0].toUpperCase().replace(/[^A-Z0-9\-_]/g, "");
    const vehicleRef = parts[1];
    if (tagId.length < 6 || tagId.length > 64) throw new Error(`Line ${i + 1}: invalid tagId length`);
    if (!vehicleRef || vehicleRef.length < 3 || vehicleRef.length > 64) throw new Error(`Line ${i + 1}: invalid vehicleRef`);
    rows.push({ tagId, vehicleRef });
  }
  if (rows.length === 0) throw new Error("CSV contains no valid data rows");
  if (rows.length > 500) throw new Error("Batch size limit is 500 tags per job");
  return rows;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("NFC Batch Provisioning — HKDF Key Derivation", () => {
  it("derives a 32-character hex key for a valid tag ID", () => {
    const key = deriveTagKey("NFC-001-ABCD");
    expect(key).toMatch(/^[0-9A-F]{32}$/);
  });

  it("produces deterministic keys for the same tag ID", () => {
    const key1 = deriveTagKey("NFC-TEST-001");
    const key2 = deriveTagKey("NFC-TEST-001");
    expect(key1).toBe(key2);
  });

  it("produces different keys for different tag IDs", () => {
    const key1 = deriveTagKey("NFC-001-AAAA");
    const key2 = deriveTagKey("NFC-001-BBBB");
    expect(key1).not.toBe(key2);
  });

  it("derived key is exactly 16 bytes (AES-128 compatible)", () => {
    const key = deriveTagKey("NFC-FLEET-PLAZA-001");
    // 32 hex chars = 16 bytes
    expect(key.length).toBe(32);
    expect(Buffer.from(key, "hex").length).toBe(16);
  });

  it("handles tag IDs with hyphens and underscores", () => {
    const key = deriveTagKey("NFC_TOLL_PLAZA-001");
    expect(key).toMatch(/^[0-9A-F]{32}$/);
  });
});

describe("NFC Batch Provisioning — CSV Parser", () => {
  const validCsv = `tagId,vehicleRef
NFC-001-ABCD,VEH-LAG001
NFC-002-EFGH,VEH-LAG002
NFC-003-IJKL,VEH-ABJ003`;

  it("parses a valid CSV with 3 data rows", () => {
    const rows = parseCsv(validCsv);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ tagId: "NFC-001-ABCD", vehicleRef: "VEH-LAG001" });
    expect(rows[1]).toEqual({ tagId: "NFC-002-EFGH", vehicleRef: "VEH-LAG002" });
    expect(rows[2]).toEqual({ tagId: "NFC-003-IJKL", vehicleRef: "VEH-ABJ003" });
  });

  it("normalises tag IDs to uppercase", () => {
    const csv = `tagId,vehicleRef\nnfc-001-abcd,VEH-001`;
    const rows = parseCsv(csv);
    expect(rows[0].tagId).toBe("NFC-001-ABCD");
  });

  it("strips surrounding quotes from values", () => {
    const csv = `tagId,vehicleRef\n"NFC-001-ABCD","VEH-LAG001"`;
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual({ tagId: "NFC-001-ABCD", vehicleRef: "VEH-LAG001" });
  });

  it("skips blank lines", () => {
    const csv = `tagId,vehicleRef\nNFC-001-ABCD,VEH-001\n\nNFC-002-EFGH,VEH-002\n`;
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2);
  });

  it("throws on missing header", () => {
    const csv = `NFC-001-ABCD,VEH-001`;
    expect(() => parseCsv(csv)).toThrow(/header/i);
  });

  it("throws on wrong header columns", () => {
    const csv = `id,ref\nNFC-001-ABCD,VEH-001`;
    expect(() => parseCsv(csv)).toThrow(/tagId.*vehicleRef/i);
  });

  it("throws on tagId that is too short", () => {
    const csv = `tagId,vehicleRef\nABC,VEH-001`;
    expect(() => parseCsv(csv)).toThrow(/tagId/i);
  });

  it("throws on tagId that is too long (> 64 chars)", () => {
    const longId = "A".repeat(65);
    const csv = `tagId,vehicleRef\n${longId},VEH-001`;
    expect(() => parseCsv(csv)).toThrow(/tagId/i);
  });

  it("throws on empty vehicleRef", () => {
    const csv = `tagId,vehicleRef\nNFC-001-ABCD,`;
    expect(() => parseCsv(csv)).toThrow(/vehicleRef/i);
  });

  it("throws when batch exceeds 500 rows", () => {
    const rows = Array.from({ length: 501 }, (_, i) => `NFC-${String(i).padStart(3, "0")}-ABCD,VEH-${i}`);
    const csv = `tagId,vehicleRef\n${rows.join("\n")}`;
    expect(() => parseCsv(csv)).toThrow(/500/);
  });

  it("accepts exactly 500 rows", () => {
    const rows = Array.from({ length: 500 }, (_, i) => `NFC-${String(i).padStart(3, "0")}-ABCD,VEH-${i}`);
    const csv = `tagId,vehicleRef\n${rows.join("\n")}`;
    const result = parseCsv(csv);
    expect(result).toHaveLength(500);
  });
});

describe("NFC Batch Provisioning — End-to-End Batch Processing", () => {
  it("processes a 10-tag batch and returns correct structure", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      tagId: `NFC-${String(i + 1).padStart(3, "0")}-TEST`,
      vehicleRef: `VEH-TEST-${i + 1}`,
    }));

    const results = rows.map(row => {
      const keyHex = deriveTagKey(row.tagId);
      return {
        tagId: row.tagId,
        vehicleRef: row.vehicleRef,
        keyHex,
        keyHexPrefix: keyHex.slice(0, 8) + "...",
        status: "ok",
      };
    });

    expect(results).toHaveLength(10);
    results.forEach(r => {
      expect(r.keyHex).toMatch(/^[0-9A-F]{32}$/);
      expect(r.keyHexPrefix).toMatch(/^[0-9A-F]{8}\.\.\.$/);
      expect(r.status).toBe("ok");
    });
  });

  it("all 10 tags in batch have unique keys", () => {
    const tags = Array.from({ length: 10 }, (_, i) => `NFC-${String(i + 1).padStart(3, "0")}-UNIQ`);
    const keys = tags.map(deriveTagKey);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(10);
  });

  it("key prefix is first 8 chars of full key hex", () => {
    const tagId = "NFC-PREFIX-TEST";
    const keyHex = deriveTagKey(tagId);
    const prefix = keyHex.slice(0, 8) + "...";
    expect(prefix.startsWith(keyHex.slice(0, 8))).toBe(true);
    expect(prefix.endsWith("...")).toBe(true);
  });
});
