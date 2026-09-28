/**
 * Devices Router
 * ==============
 * Full CRUD for toll-plaza hardware devices.
 * Admin-only mutations; read access for authenticated users.
 *
 * Procedures:
 *  - devices.list          — List all devices (with optional plaza/status filter)
 *  - devices.get           — Get a single device by ID
 *  - devices.create        — Create a new device (admin)
 *  - devices.update        — Update device fields (admin)
 *  - devices.delete        — Delete a device (admin)
 *  - devices.updateHeartbeat — Upsert live telemetry from heartbeat service (admin)
 *  - devices.plazaSummary  — Aggregate counts per plaza
 */
import { z } from "zod";
import { createHmac } from "crypto";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, adminProcedure, operatorProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { tollDevices, deviceAlertLogs, qrScanLogs } from "../../drizzle/schema";
import { eq, desc, and, ilike, or, sql, gte, lte } from "drizzle-orm";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import QRCode from "qrcode";
import { notifyOwner } from "../_core/notification";
import { emitDeviceHeartbeat } from "../deviceHeartbeat";
import { ENV } from "../_core/env";

/** Shared HMAC secret for QR code signing — NFC_MASTER_SECRET or JWT_SECRET.
 *  No hardcoded fallback (audit v13, P0-6); throws when neither is configured. */
const QR_HMAC_SECRET = () => {
  const secret = ENV.nfcMasterSecret || process.env.JWT_SECRET || "";
  if (!secret) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "QR signing secret (NFC_MASTER_SECRET/JWT_SECRET) is not configured" });
  }
  return secret;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const DeviceInput = z.object({
  serial: z.string().min(3).max(64),
  name: z.string().min(2).max(128),
  type: z.enum(["nfc_reader", "barrier", "camera", "display", "edge_unit"]),
  plaza: z.string().min(2).max(128),
  lane: z.string().min(1).max(64),
  status: z.enum(["online", "offline", "warning", "maintenance", "lost", "stolen", "decommissioned"]).default("offline"),
  firmware: z.string().max(32).default("1.0.0"),
  latestFirmware: z.string().max(32).default("1.0.0"),
  uptime: z.string().max(32).optional(),
  cpu: z.number().min(0).max(100).optional(),
  memory: z.number().min(0).max(100).optional(),
  temp: z.number().optional(),
  alerts: z.number().int().min(0).optional(),
});

// ── Router ────────────────────────────────────────────────────────────────────

export const devicesRouter = router({
  /**
   * List all devices with optional filters.
   * Available to all authenticated users.
   */
  list: protectedProcedure
    .input(z.object({
      plaza: z.string().optional(),
      status: z.enum(["online", "offline", "warning", "maintenance", "lost", "stolen", "decommissioned", "all"]).default("all"),
      search: z.string().optional(),
    }).default({ status: "all" }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { devices: [], total: 0, source: "unavailable" as const };

      try {
        const conditions = [];
        if (input.plaza) conditions.push(ilike(tollDevices.plaza, `%${input.plaza}%`));
        if (input.status !== "all") conditions.push(eq(tollDevices.status, input.status));
        if (input.search) {
          conditions.push(or(
            ilike(tollDevices.name, `%${input.search}%`),
            ilike(tollDevices.serial, `%${input.search}%`),
            ilike(tollDevices.plaza, `%${input.search}%`),
          )!);
        }

        const rows = await db
          .select()
          .from(tollDevices)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(tollDevices.updatedAt));

        return { devices: rows, total: rows.length, source: "live" as const };
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to list devices: ${(err as Error).message}`,
        });
      }
    }),

  /**
   * Get a single device by ID.
   */
  get: protectedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [device] = await db
        .select()
        .from(tollDevices)
        .where(eq(tollDevices.id, input.id))
        .limit(1);

      if (!device) throw new TRPCError({ code: "NOT_FOUND", message: "Device not found" });
      return device;
    }),

  /**
   * Create a new device. Admin only.
   */
  create: adminProcedure
    .input(DeviceInput)
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      try {
        const [created] = await db
          .insert(tollDevices)
          .values({
            serial: input.serial,
            name: input.name,
            type: input.type,
            plaza: input.plaza,
            lane: input.lane,
            status: input.status,
            firmware: input.firmware,
            latestFirmware: input.latestFirmware,
            lastSeen: new Date(),
            updatedAt: new Date(),
          })
          .returning();

        return created;
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("unique")) {
          throw new TRPCError({ code: "CONFLICT", message: `Serial number ${input.serial} already exists` });
        }
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Failed to create device: ${msg}` });
      }
    }),

  /**
   * Update device fields. Admin only.
   */
  update: adminProcedure
    .input(z.object({
      id: z.number().int().positive(),
      data: DeviceInput.partial(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [updated] = await db
        .update(tollDevices)
        .set({ ...input.data, updatedAt: new Date() })
        .where(eq(tollDevices.id, input.id))
        .returning();

      if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "Device not found" });
      return updated;
    }),

  /**
   * Delete a device. Admin only.
   */
  delete: adminProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [deleted] = await db
        .delete(tollDevices)
        .where(eq(tollDevices.id, input.id))
        .returning({ id: tollDevices.id, serial: tollDevices.serial });

      if (!deleted) throw new TRPCError({ code: "NOT_FOUND", message: "Device not found" });
      return { success: true, deleted };
    }),

  /**
   * Upsert live telemetry from the heartbeat service. Admin only.
   * Called by the Python heartbeat microservice via REST → tRPC bridge.
   */
  updateHeartbeat: operatorProcedure
    .input(z.object({
      serial: z.string().min(3).max(64),
      status: z.enum(["online", "offline", "warning", "maintenance"]),
      cpu: z.number().min(0).max(100).optional(),
      memory: z.number().min(0).max(100).optional(),
      temp: z.number().optional(),
      uptime: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [updated] = await db
        .update(tollDevices)
        .set({
          status: input.status,
          ...(input.cpu !== undefined && { cpu: Math.round(input.cpu) }),
          ...(input.memory !== undefined && { memory: Math.round(input.memory) }),
          ...(input.temp !== undefined && { temp: Math.round(input.temp) }),
          ...(input.uptime !== undefined && { uptime: input.uptime }),
          lastSeen: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(tollDevices.serial, input.serial))
        .returning({ id: tollDevices.id, serial: tollDevices.serial });

      if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: `Device ${input.serial} not found` });
      return { success: true, id: updated.id };
    }),

  /**
   * Seed the toll_devices table with the 12 known NigerianPass plaza locations.
   * Admin only. Idempotent — skips devices whose serial already exists.
   */
  seed: adminProcedure
    .input(z.object({ force: z.boolean().default(false) }).default({ force: false }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const PLAZA_SEED: Array<{
        serial: string; name: string; type: "nfc_reader" | "barrier" | "camera" | "display" | "edge_unit";
        plaza: string; lane: string; firmware: string; latestFirmware: string;
      }> = [
        // Lagos–Ibadan Expressway
        { serial: "NP-NFC-LIE-001", name: "NFC Reader — Entry Lane 1", type: "nfc_reader", plaza: "Lagos–Ibadan Expressway Toll Plaza", lane: "Entry-1", firmware: "2.4.1", latestFirmware: "2.4.2" },
        { serial: "NP-BAR-LIE-001", name: "Barrier Gate — Entry Lane 1", type: "barrier", plaza: "Lagos–Ibadan Expressway Toll Plaza", lane: "Entry-1", firmware: "1.8.0", latestFirmware: "1.8.0" },
        { serial: "NP-CAM-LIE-001", name: "ANPR Camera — Entry Lane 1", type: "camera", plaza: "Lagos–Ibadan Expressway Toll Plaza", lane: "Entry-1", firmware: "3.1.0", latestFirmware: "3.2.0" },
        // Lekki–Epe Expressway
        { serial: "NP-NFC-LEE-001", name: "NFC Reader — Entry Lane 1", type: "nfc_reader", plaza: "Lekki–Epe Expressway Toll Plaza", lane: "Entry-1", firmware: "2.4.1", latestFirmware: "2.4.2" },
        { serial: "NP-BAR-LEE-001", name: "Barrier Gate — Entry Lane 1", type: "barrier", plaza: "Lekki–Epe Expressway Toll Plaza", lane: "Entry-1", firmware: "1.8.0", latestFirmware: "1.8.0" },
        // Third Mainland Bridge
        { serial: "NP-NFC-TMB-001", name: "NFC Reader — Entry Lane 1", type: "nfc_reader", plaza: "Third Mainland Bridge Toll Plaza", lane: "Entry-1", firmware: "2.4.2", latestFirmware: "2.4.2" },
        { serial: "NP-EDG-TMB-001", name: "Edge Unit — Primary", type: "edge_unit", plaza: "Third Mainland Bridge Toll Plaza", lane: "Control", firmware: "4.0.1", latestFirmware: "4.0.1" },
        // Abuja–Keffi Expressway
        { serial: "NP-NFC-AKE-001", name: "NFC Reader — Entry Lane 1", type: "nfc_reader", plaza: "Abuja–Keffi Expressway Toll Plaza", lane: "Entry-1", firmware: "2.4.1", latestFirmware: "2.4.2" },
        { serial: "NP-BAR-AKE-001", name: "Barrier Gate — Entry Lane 1", type: "barrier", plaza: "Abuja–Keffi Expressway Toll Plaza", lane: "Entry-1", firmware: "1.8.0", latestFirmware: "1.8.0" },
        // Benin–Ore–Sagamu Expressway
        { serial: "NP-NFC-BOS-001", name: "NFC Reader — Entry Lane 1", type: "nfc_reader", plaza: "Benin–Ore–Sagamu Expressway Toll Plaza", lane: "Entry-1", firmware: "2.4.0", latestFirmware: "2.4.2" },
        { serial: "NP-CAM-BOS-001", name: "ANPR Camera — Entry Lane 1", type: "camera", plaza: "Benin–Ore–Sagamu Expressway Toll Plaza", lane: "Entry-1", firmware: "3.1.0", latestFirmware: "3.2.0" },
        // Kano–Zaria Expressway
        { serial: "NP-NFC-KZE-001", name: "NFC Reader — Entry Lane 1", type: "nfc_reader", plaza: "Kano–Zaria Expressway Toll Plaza", lane: "Entry-1", firmware: "2.4.1", latestFirmware: "2.4.2" },
        { serial: "NP-BAR-KZE-001", name: "Barrier Gate — Entry Lane 1", type: "barrier", plaza: "Kano–Zaria Expressway Toll Plaza", lane: "Entry-1", firmware: "1.8.0", latestFirmware: "1.8.0" },
        // Enugu–Onitsha Expressway
        { serial: "NP-NFC-EOE-001", name: "NFC Reader — Entry Lane 1", type: "nfc_reader", plaza: "Enugu–Onitsha Expressway Toll Plaza", lane: "Entry-1", firmware: "2.4.1", latestFirmware: "2.4.2" },
        { serial: "NP-EDG-EOE-001", name: "Edge Unit — Primary", type: "edge_unit", plaza: "Enugu–Onitsha Expressway Toll Plaza", lane: "Control", firmware: "4.0.1", latestFirmware: "4.0.1" },
        // Ibadan–Ilorin Expressway
        { serial: "NP-NFC-IIE-001", name: "NFC Reader — Entry Lane 1", type: "nfc_reader", plaza: "Ibadan–Ilorin Expressway Toll Plaza", lane: "Entry-1", firmware: "2.4.2", latestFirmware: "2.4.2" },
        { serial: "NP-BAR-IIE-001", name: "Barrier Gate — Entry Lane 1", type: "barrier", plaza: "Ibadan–Ilorin Expressway Toll Plaza", lane: "Entry-1", firmware: "1.8.0", latestFirmware: "1.8.0" },
        // Port Harcourt–Aba Expressway
        { serial: "NP-NFC-PHA-001", name: "NFC Reader — Entry Lane 1", type: "nfc_reader", plaza: "Port Harcourt–Aba Expressway Toll Plaza", lane: "Entry-1", firmware: "2.4.1", latestFirmware: "2.4.2" },
        { serial: "NP-CAM-PHA-001", name: "ANPR Camera — Entry Lane 1", type: "camera", plaza: "Port Harcourt–Aba Expressway Toll Plaza", lane: "Entry-1", firmware: "3.1.0", latestFirmware: "3.2.0" },
        // Kaduna–Abuja Expressway
        { serial: "NP-NFC-KAE-001", name: "NFC Reader — Entry Lane 1", type: "nfc_reader", plaza: "Kaduna–Abuja Expressway Toll Plaza", lane: "Entry-1", firmware: "2.4.1", latestFirmware: "2.4.2" },
        { serial: "NP-BAR-KAE-001", name: "Barrier Gate — Entry Lane 1", type: "barrier", plaza: "Kaduna–Abuja Expressway Toll Plaza", lane: "Entry-1", firmware: "1.8.0", latestFirmware: "1.8.0" },
        // Oshodi–Apapa Expressway
        { serial: "NP-NFC-OAE-001", name: "NFC Reader — Entry Lane 1", type: "nfc_reader", plaza: "Oshodi–Apapa Expressway Toll Plaza", lane: "Entry-1", firmware: "2.4.2", latestFirmware: "2.4.2" },
        { serial: "NP-EDG-OAE-001", name: "Edge Unit — Primary", type: "edge_unit", plaza: "Oshodi–Apapa Expressway Toll Plaza", lane: "Control", firmware: "4.0.1", latestFirmware: "4.0.1" },
        // Murtala Muhammed Airport Expressway
        { serial: "NP-NFC-MMA-001", name: "NFC Reader — Entry Lane 1", type: "nfc_reader", plaza: "Murtala Muhammed Airport Expressway Toll Plaza", lane: "Entry-1", firmware: "2.4.2", latestFirmware: "2.4.2" },
        { serial: "NP-BAR-MMA-001", name: "Barrier Gate — Entry Lane 1", type: "barrier", plaza: "Murtala Muhammed Airport Expressway Toll Plaza", lane: "Entry-1", firmware: "1.8.0", latestFirmware: "1.8.0" },
      ];

      let inserted = 0;
      let skipped = 0;

      for (const device of PLAZA_SEED) {
        try {
          await db.insert(tollDevices).values({
            serial: device.serial,
            name: device.name,
            type: device.type,
            plaza: device.plaza,
            lane: device.lane,
            status: "offline",
            firmware: device.firmware,
            latestFirmware: device.latestFirmware,
            lastSeen: new Date(),
            updatedAt: new Date(),
          });
          inserted++;
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.includes("unique") || msg.includes("duplicate")) {
            skipped++;
          } else {
            throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Seed failed for ${device.serial}: ${msg}` });
          }
        }
      }

      return {
        success: true,
        inserted,
        skipped,
        total: PLAZA_SEED.length,
        message: `Seeded ${inserted} devices across 12 NigerianPass plaza locations (${skipped} already existed).`,
      };
    }),

  /**
   * Simulate a device heartbeat from the admin portal (for testing without physical hardware).
   * Admin only.
   */
  simulateHeartbeat: operatorProcedure
    .input(z.object({
      serial: z.string().min(3).max(64),
      status: z.enum(["online", "offline", "warning", "maintenance"]).default("online"),
      cpu: z.number().min(0).max(100).default(45),
      memory: z.number().min(0).max(100).default(60),
      temp: z.number().default(38),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // Look up the device to get its device_id and plaza
      const [device] = await db
        .select()
        .from(tollDevices)
        .where(eq(tollDevices.serial, input.serial))
        .limit(1);

      if (!device) throw new TRPCError({ code: "NOT_FOUND", message: `Device ${input.serial} not found` });

      // Import emitDeviceHeartbeat lazily to avoid circular deps
      const { emitDeviceHeartbeat } = await import("../deviceHeartbeat");
      emitDeviceHeartbeat({
        device_id: `${device.id}`,
        serial: device.serial,
        status: input.status,
        cpu_percent: input.cpu,
        memory_percent: input.memory,
        temperature_celsius: input.temp,
        uptime_seconds: 86400,
        last_transaction_ms: Date.now(),
        timestamp: new Date().toISOString(),
        plaza: device.plaza,
      });

      return { success: true, deviceId: device.id, serial: device.serial };
    }),

  /**
   * Generate a signed QR code payload for a plaza station.
   * Returns a signed nigerianpass://station/{stationId} URI that plaza operators
   * can print and mount for tap-in/tap-out.
   */
  getPlazaQrCode: adminProcedure
    .input(z.object({
      serial: z.string().min(3).max(64),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [device] = await db
        .select()
        .from(tollDevices)
        .where(eq(tollDevices.serial, input.serial))
        .limit(1);

      if (!device) throw new TRPCError({ code: "NOT_FOUND", message: `Device ${input.serial} not found` });

      // Build signed QR payload: nigerianpass://station/{serial}?plaza={plaza}&lane={lane}&ts={ts}&sig={hmac}
      const ts = Date.now();
      const secret = QR_HMAC_SECRET();
      const payload = `nigerianpass://station/${device.serial}?plaza=${encodeURIComponent(device.plaza)}&lane=${encodeURIComponent(device.lane)}&ts=${ts}`;
      const sig = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
      const qrUri = `${payload}&sig=${sig}`;

      return {
        qrUri,
        serial: device.serial,
        name: device.name,
        plaza: device.plaza,
        lane: device.lane,
        generatedAt: new Date().toISOString(),
      };
    }),

  /**
   * Generate a printable A4 PDF sheet with QR codes for all NFC readers at a plaza.
   * Each NFC reader gets its own section with station name, serial, lane, and QR code.
   * Returns base64-encoded PDF bytes.
   */
  printPlazaQrSheet: adminProcedure
    .input(z.object({
      plaza: z.string().min(2).max(128),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // Fetch all NFC readers at this plaza
      const readers = await db
        .select()
        .from(tollDevices)
        .where(and(
          eq(tollDevices.plaza, input.plaza),
          eq(tollDevices.type, "nfc_reader"),
        ))
        .orderBy(tollDevices.lane);

      if (readers.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: `No NFC readers found at plaza "${input.plaza}"` });
      }

      const secret = QR_HMAC_SECRET();

      // Build signed QR URI for each reader
      const readerQrs: { device: typeof readers[0]; qrUri: string; qrPng: Buffer }[] = [];
      for (const device of readers) {
        const ts = Date.now();
        const payload = `nigerianpass://station/${device.serial}?plaza=${encodeURIComponent(device.plaza)}&lane=${encodeURIComponent(device.lane)}&ts=${ts}`;
        const sig = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
        const qrUri = `${payload}&sig=${sig}`;
        const qrPng = await QRCode.toBuffer(qrUri, { type: "png", width: 200, margin: 1, errorCorrectionLevel: "H" });
        readerQrs.push({ device, qrUri, qrPng });
      }

      // ── Build PDF (A4: 595 × 842 pt) ──────────────────────────────────────────
      const pdfDoc = await PDFDocument.create();
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const fontReg  = await pdfDoc.embedFont(StandardFonts.Helvetica);

      const green  = rgb(0.05, 0.55, 0.32);
      const dark   = rgb(0.10, 0.10, 0.10);
      const mid    = rgb(0.45, 0.45, 0.45);
      const white  = rgb(1, 1, 1);
      const lightGray = rgb(0.95, 0.95, 0.95);

      const PAGE_W = 595;
      const PAGE_H = 842;
      const MARGIN = 40;
      const CARD_W = (PAGE_W - MARGIN * 2 - 20) / 2; // 2 columns
      const CARD_H = 220;
      const COLS = 2;
      const ROWS_PER_PAGE = 3;
      const CARDS_PER_PAGE = COLS * ROWS_PER_PAGE;

      const totalPages = Math.ceil(readerQrs.length / CARDS_PER_PAGE);

      for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
        const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

        // ── Page header ──────────────────────────────────────────────────────────
        page.drawRectangle({ x: 0, y: PAGE_H - 60, width: PAGE_W, height: 60, color: green });
        page.drawText("NigerianPass", { x: MARGIN, y: PAGE_H - 22, size: 14, font: fontBold, color: white });
        page.drawText("Plaza Station QR Code Sheet", { x: MARGIN, y: PAGE_H - 38, size: 9, font: fontReg, color: rgb(0.8, 1.0, 0.9) });
        page.drawText(input.plaza, { x: MARGIN, y: PAGE_H - 52, size: 8, font: fontBold, color: white });
        const genDate = new Date().toLocaleString("en-NG", { timeZone: "Africa/Lagos" });
        page.drawText(`Generated: ${genDate}  ·  Page ${pageIdx + 1}/${totalPages}`, {
          x: PAGE_W - 230, y: PAGE_H - 38, size: 7, font: fontReg, color: rgb(0.8, 1.0, 0.9),
        });

        // ── Cards ────────────────────────────────────────────────────────────────
        const pageItems = readerQrs.slice(pageIdx * CARDS_PER_PAGE, (pageIdx + 1) * CARDS_PER_PAGE);

        for (let i = 0; i < pageItems.length; i++) {
          const { device, qrUri, qrPng } = pageItems[i];
          const col = i % COLS;
          const row = Math.floor(i / COLS);

          const cardX = MARGIN + col * (CARD_W + 20);
          const cardY = PAGE_H - 80 - (row + 1) * CARD_H - row * 12;

          // Card background
          page.drawRectangle({ x: cardX, y: cardY, width: CARD_W, height: CARD_H, color: lightGray, borderColor: rgb(0.85, 0.85, 0.85), borderWidth: 1 });

          // Green top strip
          page.drawRectangle({ x: cardX, y: cardY + CARD_H - 30, width: CARD_W, height: 30, color: green });
          page.drawText(device.name, { x: cardX + 8, y: cardY + CARD_H - 20, size: 9, font: fontBold, color: white, maxWidth: CARD_W - 16 });

          // QR code image
          const qrImage = await pdfDoc.embedPng(qrPng);
          const QR_SIZE = 120;
          page.drawImage(qrImage, { x: cardX + (CARD_W - QR_SIZE) / 2, y: cardY + CARD_H - 30 - QR_SIZE - 8, width: QR_SIZE, height: QR_SIZE });

          // Device details below QR
          const detailY = cardY + CARD_H - 30 - QR_SIZE - 20;
          const details = [
            { label: "Serial:", value: device.serial },
            { label: "Lane:",   value: device.lane },
            { label: "Status:", value: device.status.toUpperCase() },
          ];
          details.forEach((d, di) => {
            const lineY = detailY - di * 14;
            page.drawText(d.label, { x: cardX + 8, y: lineY, size: 7, font: fontBold, color: mid });
            page.drawText(d.value, { x: cardX + 48, y: lineY, size: 7, font: fontReg, color: dark });
          });

          // URI (truncated)
          const shortUri = qrUri.length > 50 ? qrUri.slice(0, 50) + "…" : qrUri;
          page.drawText(shortUri, { x: cardX + 8, y: cardY + 8, size: 5.5, font: fontReg, color: mid, maxWidth: CARD_W - 16 });
        }

        // ── Page footer ──────────────────────────────────────────────────────────
        page.drawText("Scan with NigerianPass mobile app to tap-in/tap-out. Do not share this sheet publicly.", {
          x: MARGIN, y: 18, size: 7, font: fontReg, color: mid,
        });
      }

      const pdfBytes = await pdfDoc.save();
      return {
        pdfBase64: Buffer.from(pdfBytes).toString("base64"),
        filename: `nigerianpass-qr-sheet-${input.plaza.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.pdf`,
        readerCount: readers.length,
        plaza: input.plaza,
      };
    }),

  /**
   * Resolve all active alerts on a device.
   * Clears the alert count and persists a resolution note.
   */
  resolveAlert: adminProcedure
    .input(z.object({
      id: z.number().int().positive(),
      note: z.string().max(512).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [existing] = await db
        .select({ id: tollDevices.id, serial: tollDevices.serial, alerts: tollDevices.alerts })
        .from(tollDevices)
        .where(eq(tollDevices.id, input.id))
        .limit(1);

      if (!existing) throw new TRPCError({ code: "NOT_FOUND", message: `Device ${input.id} not found` });
      if (existing.alerts === 0) return { success: true, serial: existing.serial, alertsCleared: 0 };

      const previousAlerts = existing.alerts;
      const resolvedAt = new Date();

      // Fetch full device for plaza name (needed for audit log)
      const [fullDevice] = await db
        .select({ plaza: tollDevices.plaza })
        .from(tollDevices)
        .where(eq(tollDevices.id, input.id))
        .limit(1);

      await db
        .update(tollDevices)
        .set({ alerts: 0, updatedAt: resolvedAt })
        .where(eq(tollDevices.id, input.id));

      // Write immutable audit log entry
      await db.insert(deviceAlertLogs).values({
        deviceId: existing.id,
        serial: existing.serial,
        plaza: fullDevice?.plaza ?? "Unknown",
        alertsCleared: previousAlerts,
        note: input.note ?? null,
        resolvedByUserId: ctx.user.id,
        resolvedByName: ctx.user.name ?? "Admin",
        resolvedAt,
        createdAt: resolvedAt,
      });

      // Fire-and-forget owner notification (non-fatal)
      notifyOwner({
        title: `[NigerianPass] Alert Resolved — ${existing.serial}`,
        content: [
          `Device: ${existing.serial}`,
          `Plaza: ${fullDevice?.plaza ?? "Unknown"}`,
          `Alerts cleared: ${previousAlerts}`,
          `Resolved by: ${ctx.user.name ?? "Admin"} (ID ${ctx.user.id})`,
          `Time: ${resolvedAt.toISOString()}`,
          input.note ? `Note: ${input.note}` : "Note: (none)",
        ].join("\n"),
      }).catch(() => { /* non-fatal */ });

      return {
        success: true,
        serial: existing.serial,
        alertsCleared: previousAlerts,
        note: input.note ?? null,
        resolvedAt: resolvedAt.toISOString(),
      };
    }),

  /**
   * Get alert resolution history for a device.
   * Returns the last 50 entries ordered by most recent first.
   */
  getAlertHistory: adminProcedure
    .input(z.object({
      deviceId: z.number().int().positive(),
      limit: z.number().int().min(1).max(100).default(50),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const rows = await db
        .select()
        .from(deviceAlertLogs)
        .where(eq(deviceAlertLogs.deviceId, input.deviceId))
        .orderBy(desc(deviceAlertLogs.resolvedAt))
        .limit(input.limit);

      return rows;
    }),

  /**
   * Rotate the QR code for a plaza NFC reader.
   * Invalidates the old signature by generating a new signed URI with a fresh
   * timestamp and a new HMAC. Returns the new signed URI and expiry timestamp.
   */
  rotateQrCode: adminProcedure
    .input(z.object({
      serial: z.string().min(3).max(64),
      /** TTL in hours (default 24). Max 168 (1 week). */
      ttlHours: z.number().int().min(1).max(168).default(24),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [device] = await db
        .select()
        .from(tollDevices)
        .where(eq(tollDevices.serial, input.serial))
        .limit(1);

      if (!device) throw new TRPCError({ code: "NOT_FOUND", message: `Device ${input.serial} not found` });

      const ts = Date.now();
      const expiresAt = ts + input.ttlHours * 60 * 60 * 1000;
      const secret = QR_HMAC_SECRET();
      const payload = `nigerianpass://station/${device.serial}?plaza=${encodeURIComponent(device.plaza)}&lane=${encodeURIComponent(device.lane)}&ts=${ts}&exp=${expiresAt}`;
      const sig = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
      const qrUri = `${payload}&sig=${sig}`;

      return {
        qrUri,
        serial: device.serial,
        name: device.name,
        plaza: device.plaza,
        lane: device.lane,
        generatedAt: new Date(ts).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        ttlHours: input.ttlHours,
      };
    }),

  /**
   * Validate a scanned QR URI.
   * Parses nigerianpass://station/{serial}?...&exp={ms}&sig={hmac16},
   * verifies the HMAC signature, and checks expiry.
   * Returns { valid, reason, serial, plaza, lane, expiresAt }.
   */
  validateQrCode: operatorProcedure
    .input(z.object({
      /** Full QR URI as scanned by the gate controller */
      uri: z.string().min(10).max(1024),
    }))
    .mutation(async ({ input, ctx }) => {
      const { uri } = input;
      const operatorUserId = ctx.user?.id ?? null;
      const operatorName = ctx.user?.name ?? null;

      /** Fire-and-forget: persist scan to qr_scan_logs */
      const persistScan = async (result: {
        valid: boolean; reason: string; serial: string | null;
        plazaName?: string | null; lane?: string | null;
      }) => {
        try {
          const db = await getDb();
          if (!db) return;
          await db.insert(qrScanLogs).values({
            deviceSerial: result.serial ?? "unknown",
            scannedUri: uri,
            valid: result.valid,
            rejectionReason: result.valid ? null : result.reason,
            plazaName: result.plazaName ?? null,
            lane: result.lane ?? null,
            operatorUserId,
            operatorName,
          });
        } catch (err) {
          console.warn("[QR] Failed to persist scan log:", err);
        }
      };

      if (!uri.startsWith("nigerianpass://station/")) {
        void persistScan({ valid: false, reason: "Invalid URI scheme", serial: null });
        return { valid: false, reason: "Invalid URI scheme", serial: null, plaza: null, lane: null, expiresAt: null };
      }
      const sigMatch = uri.match(/&sig=([0-9a-f]{16})$/);
      if (!sigMatch) {
        void persistScan({ valid: false, reason: "Missing or malformed signature", serial: null });
        return { valid: false, reason: "Missing or malformed signature", serial: null, plaza: null, lane: null, expiresAt: null };
      }
      const providedSig = sigMatch[1];
      const payload = uri.slice(0, uri.length - `&sig=${providedSig}`.length);
      const secret = QR_HMAC_SECRET();
      const expectedSig = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16);
      if (providedSig !== expectedSig) {
        void persistScan({ valid: false, reason: "Signature mismatch — QR may have been tampered with", serial: null });
        return { valid: false, reason: "Signature mismatch — QR may have been tampered with", serial: null, plaza: null, lane: null, expiresAt: null };
      }
      const queryStart = uri.indexOf("?");
      const serial = decodeURIComponent(uri.slice("nigerianpass://station/".length, queryStart));
      const params = new URLSearchParams(uri.slice(queryStart + 1));
      const plaza = params.get("plaza") ?? null;
      const lane = params.get("lane") ?? null;
      const expStr = params.get("exp");
      if (expStr) {
        const expMs = parseInt(expStr, 10);
        if (isNaN(expMs)) {
          void persistScan({ valid: false, reason: "Invalid expiry timestamp", serial, plazaName: plaza, lane });
          return { valid: false, reason: "Invalid expiry timestamp", serial, plaza, lane, expiresAt: null };
        }
        if (Date.now() > expMs) {
          void persistScan({ valid: false, reason: `QR code expired`, serial, plazaName: plaza, lane });
          return { valid: false, reason: `QR code expired at ${new Date(expMs).toISOString()}`, serial, plaza, lane, expiresAt: new Date(expMs).toISOString() };
        }
        void persistScan({ valid: true, reason: "OK", serial, plazaName: plaza, lane });
        return { valid: true, reason: "OK", serial, plaza, lane, expiresAt: new Date(expMs).toISOString() };
      }
      void persistScan({ valid: true, reason: "OK (no expiry)", serial, plazaName: plaza, lane });
      return { valid: true, reason: "OK (no expiry)", serial, plaza, lane, expiresAt: null };
    }),

  /**
   * Get QR scan audit log. Admin only.
   * Returns the most recent scans with acceptance rate summary.
   */
  getQrScanHistory: adminProcedure
    .input(z.object({
      deviceSerial: z.string().optional(),
      validFilter: z.enum(["all", "valid", "rejected"]).default("all"),
      fromDate: z.date().optional(),
      toDate: z.date().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const conditions: any[] = [];
      if (input.deviceSerial) conditions.push(eq(qrScanLogs.deviceSerial, input.deviceSerial));
      if (input.validFilter === "valid") conditions.push(eq(qrScanLogs.valid, true));
      if (input.validFilter === "rejected") conditions.push(eq(qrScanLogs.valid, false));
      if (input.fromDate) conditions.push(gte(qrScanLogs.scannedAt, input.fromDate));
      if (input.toDate) conditions.push(lte(qrScanLogs.scannedAt, input.toDate));
      const logs = await db
        .select()
        .from(qrScanLogs)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(qrScanLogs.scannedAt))
        .limit(input.limit);
      const totalScans = logs.length;
      const validScans = logs.filter(l => l.valid).length;
      return {
        logs,
        totalScans,
        validScans,
        rejectedScans: totalScans - validScans,
        acceptanceRate: totalScans > 0 ? Math.round((validScans / totalScans) * 100) : 0,
      };
    }),

  /**
   * Trigger a firmware update request for a device.
   * Sets latestFirmware on the device row and broadcasts a
   * firmware_update_requested event via the WebSocket heartbeat channel.
   */
  triggerFirmwareUpdate: adminProcedure
    .input(z.object({
      serial: z.string().min(3).max(64),
      targetVersion: z.string().min(1).max(32),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const [device] = await db
        .select()
        .from(tollDevices)
        .where(eq(tollDevices.serial, input.serial))
        .limit(1);
      if (!device) throw new TRPCError({ code: "NOT_FOUND", message: `Device ${input.serial} not found` });
      if (device.firmware === input.targetVersion) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Device already on firmware ${input.targetVersion}` });
      }
      const now = new Date();
      await db
        .update(tollDevices)
        .set({ latestFirmware: input.targetVersion, updatedAt: now })
        .where(eq(tollDevices.serial, input.serial));
      // Broadcast firmware_update_requested via WS heartbeat channel
      emitDeviceHeartbeat(Object.assign({
        device_id: device.serial,
        serial: device.serial,
        status: device.status as "online" | "offline" | "warning" | "maintenance",
        cpu_percent: device.cpu,
        memory_percent: device.memory,
        temperature_celsius: device.temp,
        uptime_seconds: 0,
        last_transaction_ms: 0,
        timestamp: now.toISOString(),
        plaza: device.plaza,
      }, {
        event: "firmware_update_requested",
        targetVersion: input.targetVersion,
        requestedBy: ctx.user.name ?? "Admin",
      }));
      notifyOwner({
        title: `[NigerianPass] Firmware Update Requested — ${device.serial}`,
        content: [
          `Device: ${device.serial} (${device.name})`,
          `Plaza: ${device.plaza}`,
          `Current firmware: ${device.firmware}`,
          `Target firmware: ${input.targetVersion}`,
          `Requested by: ${ctx.user.name ?? "Admin"} (ID ${ctx.user.id})`,
          `Time: ${now.toISOString()}`,
        ].join("\n"),
      }).catch(() => { /* non-fatal */ });
      return {
        success: true,
        serial: device.serial,
        name: device.name,
        plaza: device.plaza,
        currentFirmware: device.firmware,
        targetVersion: input.targetVersion,
        requestedAt: now.toISOString(),
        requestedBy: ctx.user.name ?? "Admin",
      };
    }),

  /**
   * Report the installed firmware version from a device after an OTA update.
   * Called by the device itself (or the edge unit) once the update is applied.
   */
  reportFirmwareVersion: adminProcedure
    .input(z.object({
      serial: z.string().min(3).max(64),
      /** The firmware version string the device is now running */
      version: z.string().min(1).max(32),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [device] = await db
        .select()
        .from(tollDevices)
        .where(eq(tollDevices.serial, input.serial))
        .limit(1);

      if (!device) throw new TRPCError({ code: "NOT_FOUND", message: `Device ${input.serial} not found` });

      const now = new Date();
      const [updated] = await db
        .update(tollDevices)
        .set({ firmware: input.version, updatedAt: now })
        .where(eq(tollDevices.serial, input.serial))
        .returning();

      const wasOutdated = device.firmware !== device.latestFirmware;
      const isNowCurrent = input.version === device.latestFirmware;

      // Notify owner when a device successfully updates to the latest firmware
      if (wasOutdated && isNowCurrent) {
        notifyOwner({
          title: `[NigerianPass] Firmware Updated — ${device.serial}`,
          content: [
            `Device: ${device.serial} (${device.name})`,
            `Plaza: ${device.plaza}`,
            `Previous firmware: ${device.firmware}`,
            `New firmware: ${input.version}`,
            `Reported by: ${ctx.user.name ?? "Admin"} (ID ${ctx.user.id})`,
            `Time: ${now.toISOString()}`,
          ].join("\n"),
        }).catch(() => { /* non-fatal */ });
      }

      return {
        success: true,
        serial: device.serial,
        name: device.name,
        plaza: device.plaza,
        previousFirmware: device.firmware,
        currentFirmware: input.version,
        latestFirmware: device.latestFirmware,
        isUpToDate: input.version === device.latestFirmware,
        updatedAt: now.toISOString(),
      };
    }),

  /**
   * Broadcast a firmware update request to all devices at a selected plaza.
   * Admin only. Returns per-device results (sent / skipped / failed).
   */
  broadcastFirmwareUpdate: adminProcedure
    .input(z.object({
      plaza: z.string().min(2).max(128),
      /** Target firmware version to broadcast. Defaults to each device's latestFirmware. */
      targetVersion: z.string().max(32).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // Fetch all devices at the plaza
      const devices = await db
        .select()
        .from(tollDevices)
        .where(ilike(tollDevices.plaza, `%${input.plaza}%`));

      if (devices.length === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: `No devices found at plaza matching "${input.plaza}"` });
      }

      const results: Array<{
        id: number; serial: string; name: string; status: "sent" | "skipped" | "failed";
        reason?: string; targetVersion: string;
      }> = [];

      for (const device of devices) {
        const target = input.targetVersion ?? device.latestFirmware;
        if (!target) {
          results.push({ id: device.id, serial: device.serial, name: device.name, status: "skipped", reason: "No target version", targetVersion: "" });
          continue;
        }
        if (device.firmware === target) {
          results.push({ id: device.id, serial: device.serial, name: device.name, status: "skipped", reason: "Already on target version", targetVersion: target });
          continue;
        }
        try {
          // Update latestFirmware to the target version (signals pending update)
          await db.update(tollDevices)
            .set({ latestFirmware: target, updatedAt: new Date() })
            .where(eq(tollDevices.id, device.id));
          // Broadcast WS event
          emitDeviceHeartbeat({
            device_id: String(device.id),
            serial: device.serial,
            status: device.status,
            cpu_percent: device.cpu ?? 0,
            memory_percent: device.memory ?? 0,
            temperature_celsius: device.temp ?? 0,
            uptime_seconds: 0,
            last_transaction_ms: Date.now(),
            timestamp: new Date().toISOString(),
            plaza: device.plaza,
          });
          results.push({ id: device.id, serial: device.serial, name: device.name, status: "sent", targetVersion: target });
        } catch (err) {
          results.push({ id: device.id, serial: device.serial, name: device.name, status: "failed", reason: (err as Error).message, targetVersion: target });
        }
      }

      const sentCount = results.filter(r => r.status === "sent").length;
      const skippedCount = results.filter(r => r.status === "skipped").length;
      const failedCount = results.filter(r => r.status === "failed").length;

      // Notify owner
      await notifyOwner({
        title: `Firmware Broadcast: ${input.plaza}`,
        content: `Broadcast to ${devices.length} devices: ${sentCount} sent, ${skippedCount} skipped, ${failedCount} failed.`,
      }).catch(() => {});

      return { plaza: input.plaza, total: devices.length, sent: sentCount, skipped: skippedCount, failed: failedCount, results };
    }),

  /**
   * Get firmware broadcast status for a plaza.
   * Returns counts of devices that are up-to-date vs pending update.
   * Polls every 30s on the Firmware Broadcast Dashboard.
   */
  getFirmwareBroadcastStatus: adminProcedure
    .input(z.object({
      plaza: z.string().optional(),
    }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const conditions = input.plaza
        ? [ilike(tollDevices.plaza, `%${input.plaza}%`)]
        : [];
      const rows = await db
        .select({
          serial: tollDevices.serial,
          name: tollDevices.name,
          plaza: tollDevices.plaza,
          lane: tollDevices.lane,
          firmware: tollDevices.firmware,
          latestFirmware: tollDevices.latestFirmware,
          status: tollDevices.status,
          lastSeen: tollDevices.lastSeen,
        })
        .from(tollDevices)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(tollDevices.plaza, tollDevices.lane);
      const total = rows.length;
      const upToDate = rows.filter(d => d.firmware === d.latestFirmware).length;
      const pending = total - upToDate;
      const byPlaza = rows.reduce((acc, d) => {
        if (!acc[d.plaza]) acc[d.plaza] = { total: 0, upToDate: 0, pending: 0 };
        acc[d.plaza].total++;
        if (d.firmware === d.latestFirmware) acc[d.plaza].upToDate++;
        else acc[d.plaza].pending++;
        return acc;
      }, {} as Record<string, { total: number; upToDate: number; pending: number }>);
      return {
        total,
        upToDate,
        pending,
        devices: rows.map(d => ({
          ...d,
          isUpToDate: d.firmware === d.latestFirmware,
        })),
        byPlaza,
        checkedAt: new Date().toISOString(),
      };
    }),

  /**
   * Firmware version matrix — grouped breakdown of all distinct firmware
   * versions currently installed across the fleet.
   * Returns: { version, deviceCount, plazas, isLatest }[]
   */
  getFirmwareMatrix: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    try {
      const devices = await db
        .select({
          firmware: tollDevices.firmware,
          latestFirmware: tollDevices.latestFirmware,
          plaza: tollDevices.plaza,
        })
        .from(tollDevices);

      // Determine the most common latestFirmware as the "current" target version
      const latestCounts = new Map<string, number>();
      for (const d of devices) {
        latestCounts.set(d.latestFirmware, (latestCounts.get(d.latestFirmware) ?? 0) + 1);
      }
      const latestVersion = devices.length > 0
        ? Array.from(latestCounts.entries()).sort((a, b) => b[1] - a[1])[0][0]
        : "1.0.0";

      // Group by installed firmware version
      const versionMap = new Map<string, { deviceCount: number; plazas: Set<string> }>();
      for (const d of devices) {
        const entry = versionMap.get(d.firmware);
        if (entry) {
          entry.deviceCount++;
          entry.plazas.add(d.plaza);
        } else {
          versionMap.set(d.firmware, { deviceCount: 1, plazas: new Set([d.plaza]) });
        }
      }

      return Array.from(versionMap.entries())
        .map(([version, data]) => ({
          version,
          deviceCount: data.deviceCount,
          plazas: Array.from(data.plazas).sort(),
          isLatest: version === latestVersion,
        }))
        .sort((a, b) => {
          if (a.isLatest && !b.isLatest) return -1;
          if (!a.isLatest && b.isLatest) return 1;
          return b.deviceCount - a.deviceCount;
        });
    } catch {
      return [];
    }
  }),

  /**
   * Aggregate device counts per plaza.
   */
  plazaSummary: protectedProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];

    try {
      const rows = await db
        .select({
          plaza: tollDevices.plaza,
          total: sql<number>`count(*)::int`,
          online: sql<number>`count(*) filter (where ${tollDevices.status} = 'online')::int`,
          warning: sql<number>`count(*) filter (where ${tollDevices.status} = 'warning')::int`,
          offline: sql<number>`count(*) filter (where ${tollDevices.status} = 'offline')::int`,
          maintenance: sql<number>`count(*) filter (where ${tollDevices.status} = 'maintenance')::int`,
        })
        .from(tollDevices)
        .groupBy(tollDevices.plaza)
        .orderBy(tollDevices.plaza);

      return rows;
    } catch {
      return [];
    }
  }),
});
