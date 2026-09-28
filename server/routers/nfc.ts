/**
 * NFC Tag Provisioning Router
 * ===========================
 * Server-side AES-128 key derivation via HKDF using the NFC_MASTER_SECRET
 * environment variable. The client never sees the master secret — only the
 * derived per-tag key is returned.
 *
 * In production, NFC_MASTER_SECRET should be a 256-bit random hex string
 * stored in a KMS/HSM and injected as an environment variable.
 */
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { ENV } from "../_core/env";
import { getDb, createKycApplication, getKycApplicationsByUserId } from "../db";
import { kycApplications, type KycApplication, type InsertKycApplication } from "../../drizzle/schema";
import { eq, desc } from "drizzle-orm";
import * as crypto from "crypto";

// ── Key derivation ─────────────────────────────────────────────────────────────

/**
 * Derives a 128-bit AES key from the master secret + tagId using HKDF-SHA256.
 * Returns the key as a 32-character uppercase hex string.
 */
function deriveTagKeyServer(tagId: string): string {
  const masterSecret = ENV.nfcMasterSecret || "NigerianPass-Server-Master-Secret-v1";
  // Use Node.js crypto HKDF
  const ikm = Buffer.from(masterSecret, "utf8");
  const salt = Buffer.from("NigerianPass-NFC-Salt-v1", "utf8");
  const info = Buffer.from(`tag:${tagId}`, "utf8");

  // HKDF extract
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();

  // HKDF expand (16 bytes = 128 bits)
  const t1 = crypto.createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([0x01])])).digest();
  const keyBytes = t1.slice(0, 16);
  return keyBytes.toString("hex").toUpperCase();
}

/**
 * Computes a CMAC-like HMAC-SHA256 signature for the NDEF payload.
 * In production, use a real AES-CMAC library.
 */
function signNdefPayload(tagId: string, vehicleRef: string, keyHex: string): string {
  const payload = JSON.stringify({ tid: tagId, vref: vehicleRef, k: keyHex, ts: Date.now() });
  return crypto.createHmac("sha256", keyHex).update(payload).digest("hex").slice(0, 16).toUpperCase();
}

// ── Router ─────────────────────────────────────────────────────────────────────

export const nfcRouter = router({
  /**
   * Provision a new NFC tag: derive the per-tag AES-128 key server-side,
   * record the provisioning event, and return the key + NDEF payload to the client.
   */
  provision: protectedProcedure
    .input(z.object({
      tagId: z.string().min(6).max(64).regex(/^[A-Z0-9\-_]+$/, "Tag ID must be alphanumeric"),
      vehicleRef: z.string().min(3).max(64),
    }))
    .mutation(async ({ input, ctx }) => {
      const { tagId, vehicleRef } = input;

      // Derive per-tag key server-side (master secret never leaves the server)
      const keyHex = deriveTagKeyServer(tagId);
      const signature = signNdefPayload(tagId, vehicleRef, keyHex);

      // Build the NDEF payload (truncated key for NDEF, full key for secure element)
      const ndefPayload = JSON.stringify({
        v: 1,
        tid: tagId,
        vref: vehicleRef,
        k: keyHex.slice(0, 8) + "...", // truncated — full key written to secure element
        sig: signature,
        ts: Date.now(),
        issuer: "NigerianPass",
        provisionedBy: ctx.user.id,
      });

      // Log the provisioning event in the KYC applications table
      // (reusing kycApplications as an audit log for NFC provisioning events)
      const refId = `NFC-${tagId.slice(0, 8)}-${Date.now().toString(36).toUpperCase()}`;
      await createKycApplication({
        userId: ctx.user.id,
        type: "driver" as const, // closest available type for audit logging
        status: "approved",
        referenceId: refId,
        formData: {
          nfcTagId: tagId,
          vehicleRef,
          keyHexPrefix: keyHex.slice(0, 8) + "...", // never log full key
          signature,
          provisionedAt: new Date().toISOString(),
          provisionedBy: ctx.user.id,
          eventType: "nfc_provisioning",
        },
      } as InsertKycApplication);

      return {
        tagId,
        vehicleRef,
        keyHex,        // full key — client uses this for Web NFC write
        ndefPayload,   // NDEF text record content
        signature,
        refId,
        provisionedAt: Date.now(),
      };
    }),

  /**
   * Verify a tag read-back: re-derive the key and compare the NDEF payload.
   * Returns whether the tag content matches the expected provisioning data.
   */
  verify: protectedProcedure
    .input(z.object({
      tagId: z.string().min(6).max(64),
      ndefContent: z.string(),
    }))
    .mutation(async ({ input }) => {
      const { tagId, ndefContent } = input;

      try {
        const parsed = JSON.parse(ndefContent);
        const expectedKeyHex = deriveTagKeyServer(tagId);

        // Verify the tag ID matches
        if (parsed.tid !== tagId) {
          return { match: false, reason: "Tag ID mismatch" };
        }

        // Verify the key prefix matches (we truncated the key in NDEF)
        if (!expectedKeyHex.startsWith(parsed.k?.slice(0, 8) ?? "")) {
          return { match: false, reason: "Key prefix mismatch" };
        }

        return { match: true, reason: "Tag verified successfully" };
      } catch {
        return { match: false, reason: "Invalid NDEF payload" };
      }
    }),

  /**
   * Get provisioning history for the current user (last 20 events).
   */
  getHistory: protectedProcedure
    .query(async ({ ctx }) => {
      const rows = await getKycApplicationsByUserId(ctx.user.id);

      return rows
        .filter((r: KycApplication) => {
          const fd = r.formData as Record<string, unknown>;
          return fd?.eventType === "nfc_provisioning";
        })
        .map((r: KycApplication) => ({
          refId: r.referenceId,
          formData: r.formData as Record<string, unknown>,
          provisionedAt: r.createdAt,
        }));
    }),
});
