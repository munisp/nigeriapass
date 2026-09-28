/**
 * NFC Tag Provisioning Router
 * ===========================
 * Server-side AES-128 key derivation via HKDF using the NFC_MASTER_SECRET
 * environment variable. The client never sees the master secret.
 *
 * Audit v13 hardening:
 *  - NFC_MASTER_SECRET is REQUIRED — there is no hardcoded fallback (P0-6).
 *  - All mutations require operator/admin role (P0-6).
 *  - The full derived key is returned to admins only; operators receive a
 *    masked prefix (P0-6).
 *  - Provisioning events are written to nfc_provisioning_events, NOT to
 *    kyc_applications (P0-7).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { operatorProcedure, protectedProcedure, router } from "../_core/trpc";
import { ENV } from "../_core/env";
import { getDb } from "../db";
import { nfcProvisioningEvents } from "../../drizzle/schema";
import { eq, desc } from "drizzle-orm";
import * as crypto from "crypto";
import { audit } from "../_core/audit";

// ── Key derivation ─────────────────────────────────────────────────────────────

/** Fail closed: the master secret must come from the environment. */
function requireMasterSecret(): string {
  if (!ENV.nfcMasterSecret) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "NFC_MASTER_SECRET is not configured. NFC provisioning is disabled.",
    });
  }
  return ENV.nfcMasterSecret;
}

/**
 * Derives a 128-bit AES key from the master secret + tagId using HKDF-SHA256.
 * Returns the key as a 32-character uppercase hex string.
 */
function deriveTagKeyServer(tagId: string): string {
  const masterSecret = requireMasterSecret();
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

/** Mask a derived key: first 8 hex chars + ellipsis. */
function maskKey(keyHex: string): string {
  return keyHex.slice(0, 8) + "...";
}

// ── Router ─────────────────────────────────────────────────────────────────────

export const nfcRouter = router({
  /**
   * Provision a new NFC tag: derive the per-tag AES-128 key server-side,
   * record the provisioning event in nfc_provisioning_events, and return the
   * key + NDEF payload to the client.
   *
   * RBAC: operators may provision, but only admins receive the full derived
   * key — operators get a masked prefix (P0-6).
   */
  provision: operatorProcedure
    .input(z.object({
      tagId: z.string().min(6).max(64).regex(/^[A-Z0-9\-_]+$/, "Tag ID must be alphanumeric"),
      vehicleRef: z.string().min(3).max(64),
    }))
    .mutation(async ({ input, ctx }) => {
      const { tagId, vehicleRef } = input;
      const isAdmin = ctx.user.role === "admin";

      // Derive per-tag key server-side (master secret never leaves the server)
      const keyHex = deriveTagKeyServer(tagId);
      const signature = signNdefPayload(tagId, vehicleRef, keyHex);

      // Build the NDEF payload (truncated key for NDEF, full key for secure element)
      const ndefPayload = JSON.stringify({
        v: 1,
        tid: tagId,
        vref: vehicleRef,
        k: maskKey(keyHex), // truncated — full key written to secure element
        sig: signature,
        ts: Date.now(),
        issuer: "NigerianPass",
        provisionedBy: ctx.user.id,
      });

      // Record the provisioning event in the dedicated audit table (P0-7).
      const refId = `NFC-${tagId.slice(0, 8)}-${Date.now().toString(36).toUpperCase()}`;
      const db = await getDb();
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      }
      await db.insert(nfcProvisioningEvents).values({
        refId,
        tagId,
        vehicleRef,
        keyHexPrefix: maskKey(keyHex), // never store the full key
        signature,
        provisionedBy: ctx.user.id,
      });

      void audit(ctx, "nfc.provision", "nfc_tag", tagId, {
        refId,
        vehicleRef,
        keyHexPrefix: maskKey(keyHex),
      });

      return {
        tagId,
        vehicleRef,
        // Full key only for admins — operators get the masked prefix (P0-6)
        keyHex: isAdmin ? keyHex : maskKey(keyHex),
        keyMasked: !isAdmin,
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
  verify: operatorProcedure
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
   * Reads from nfc_provisioning_events (not kyc_applications).
   */
  getHistory: protectedProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) return [];

      const isAdmin = ctx.user.role === "admin";
      const rows = await db
        .select()
        .from(nfcProvisioningEvents)
        .where(isAdmin ? undefined : eq(nfcProvisioningEvents.provisionedBy, ctx.user.id))
        .orderBy(desc(nfcProvisioningEvents.createdAt))
        .limit(20);

      return rows.map(r => ({
        refId: r.refId,
        tagId: r.tagId,
        vehicleRef: r.vehicleRef,
        keyHexPrefix: r.keyHexPrefix,
        signature: r.signature,
        provisionedBy: r.provisionedBy,
        provisionedAt: r.createdAt,
      }));
    }),
});
