/**
 * KYC Router
 * ==========
 * Procedures for submitting KYC/KYB applications.
 *
 * Procedures:
 *  - kyc.submitFleetKYB   — Submit a Fleet KYB application (company + contact + docs)
 *  - kyc.registerVehicle  — Submit a Vehicle Registration application
 *  - kyc.getMyApplications — List all KYC applications for the current user
 *  - kyc.getApplicationStatus — Get the status of a single application by reference ID
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { kycApplications } from "../../drizzle/schema";
import { eq, desc } from "drizzle-orm";

// ── Reference ID generator ────────────────────────────────────────────────────
function generateRef(prefix: string): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < 5; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${prefix}-${suffix}`;
}

// ── KYC score calculator ──────────────────────────────────────────────────────
function calcFleetScore(data: {
  cacNumber: string;
  tinNumber: string;
  rcNumber: string;
  contactNIN: string;
  uploadedDocIds: string[];
}): number {
  let score = 40; // base
  if (data.cacNumber.length >= 6) score += 15;
  if (data.tinNumber.match(/^\d{8}$/)) score += 15;
  if (data.rcNumber.length >= 4) score += 10;
  if (data.contactNIN.match(/^\d{11}$/)) score += 10;
  if (data.uploadedDocIds.includes("cac_cert")) score += 5;
  if (data.uploadedDocIds.includes("tin_cert")) score += 5;
  return Math.min(score, 100);
}

function calcVehicleScore(data: {
  plateNumber: string;
  engineNumber: string;
  chassisNumber: string;
  ownerNIN: string;
  uploadedDocIds: string[];
}): number {
  let score = 40; // base
  if (data.plateNumber.length >= 5) score += 15;
  if (data.engineNumber.length >= 5) score += 10;
  if (data.chassisNumber.length >= 10) score += 10;
  if (data.ownerNIN.match(/^\d{11}$/)) score += 15;
  if (data.uploadedDocIds.includes("reg_cert")) score += 5;
  if (data.uploadedDocIds.includes("insurance")) score += 5;
  return Math.min(score, 100);
}

// ── Router ────────────────────────────────────────────────────────────────────
export const kycRouter = router({

  /**
   * Submit a Fleet KYB application.
   * Creates a new kycApplications row with type="fleet" and status="submitted".
   */
  submitFleetKYB: protectedProcedure
    .input(z.object({
      // Company info
      companyName: z.string().min(3),
      cacNumber: z.string().min(6),
      tinNumber: z.string().regex(/^\d{8}$/, "TIN must be 8 digits"),
      rcNumber: z.string().min(4),
      businessType: z.enum(["limited", "plc", "sole", "partnership", "ngo"]),
      industry: z.string().min(1),
      address: z.string().min(10),
      state: z.string().min(1),
      website: z.string().url().optional().or(z.literal("")),
      // Contact person
      contactName: z.string().min(2),
      contactTitle: z.string().min(2),
      contactPhone: z.string().regex(/^(\+234|0)[789]\d{9}$/),
      contactEmail: z.string().email(),
      contactNIN: z.string().regex(/^\d{11}$/),
      // Account setup
      creditLimitRequested: z.number().int().min(0).optional(),
      // Uploaded document IDs (e.g. ["cac_cert", "tin_cert"])
      uploadedDocIds: z.array(z.string()).default([]),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const referenceId = generateRef("FLT");
      const kycScore = calcFleetScore({
        cacNumber: input.cacNumber,
        tinNumber: input.tinNumber,
        rcNumber: input.rcNumber,
        contactNIN: input.contactNIN,
        uploadedDocIds: input.uploadedDocIds,
      });

      const formData = {
        company_name: input.companyName,
        cac_number: input.cacNumber,
        tin_number: input.tinNumber,
        rc_number: input.rcNumber,
        company_type: input.businessType,
        industry: input.industry,
        address: input.address,
        state: input.state,
        website: input.website || null,
        contact_name: input.contactName,
        contact_title: input.contactTitle,
        contact_phone: input.contactPhone,
        contact_email: input.contactEmail,
        contact_nin: input.contactNIN,
        credit_limit_requested: input.creditLimitRequested ?? null,
        uploaded_docs: input.uploadedDocIds,
      };

      if (!db) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database unavailable. Please try again shortly.",
        });
      }

      try {
        const [inserted] = await db
          .insert(kycApplications)
          .values({
            referenceId,
            userId: ctx.user.id,
            type: "fleet",
            status: "submitted",
            formData,
            kycScore,
            fromOfflineQueue: false,
            clientVersion: 1,
          })
          .returning({ id: kycApplications.id, referenceId: kycApplications.referenceId });

        console.log(`[KYC] Fleet KYB submitted: ${inserted.referenceId} by user ${ctx.user.id}`);

        return {
          referenceId: inserted.referenceId,
          status: "submitted" as const,
          kycScore,
          message: "Fleet KYB application submitted successfully",
        };
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to submit Fleet KYB: ${(err as Error).message}`,
        });
      }
    }),

  /**
   * Submit a Vehicle Registration application.
   * Creates a new kycApplications row with type="vehicle" and status="submitted".
   */
  registerVehicle: protectedProcedure
    .input(z.object({
      plateNumber: z.string().min(5).max(10),
      make: z.string().min(2),
      model: z.string().min(1),
      year: z.number().int().min(1990).max(new Date().getFullYear() + 1),
      colour: z.string().min(2),
      vehicleType: z.enum(["private", "commercial", "motorcycle", "truck", "bus"]),
      engineNumber: z.string().min(5),
      chassisNumber: z.string().min(10),
      ownerNIN: z.string().regex(/^\d{11}$/),
      tollClass: z.string().min(1),
      uploadedDocIds: z.array(z.string()).default([]),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      const referenceId = generateRef("VEH");
      const kycScore = calcVehicleScore({
        plateNumber: input.plateNumber,
        engineNumber: input.engineNumber,
        chassisNumber: input.chassisNumber,
        ownerNIN: input.ownerNIN,
        uploadedDocIds: input.uploadedDocIds,
      });

      const formData = {
        plate_number: input.plateNumber,
        make: input.make,
        model: input.model,
        year: input.year,
        colour: input.colour,
        vehicle_type: input.vehicleType,
        engine_number: input.engineNumber,
        chassis_number: input.chassisNumber,
        owner_nin: input.ownerNIN,
        toll_class: input.tollClass,
        uploaded_docs: input.uploadedDocIds,
      };

      if (!db) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Database unavailable. Please try again shortly.",
        });
      }

      try {
        const [inserted] = await db
          .insert(kycApplications)
          .values({
            referenceId,
            userId: ctx.user.id,
            type: "vehicle",
            status: "submitted",
            formData,
            kycScore,
            fromOfflineQueue: false,
            clientVersion: 1,
          })
          .returning({ id: kycApplications.id, referenceId: kycApplications.referenceId });

        console.log(`[KYC] Vehicle registered: ${inserted.referenceId} by user ${ctx.user.id}`);

        return {
          referenceId: inserted.referenceId,
          status: "submitted" as const,
          kycScore,
          message: "Vehicle registration submitted successfully",
        };
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to register vehicle: ${(err as Error).message}`,
        });
      }
    }),

  /**
   * List all KYC applications for the current authenticated user.
   */
  getMyApplications: protectedProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) return [];

      try {
        const apps = await db
          .select({
            id: kycApplications.id,
            referenceId: kycApplications.referenceId,
            type: kycApplications.type,
            status: kycApplications.status,
            kycScore: kycApplications.kycScore,
            createdAt: kycApplications.createdAt,
            updatedAt: kycApplications.updatedAt,
          })
          .from(kycApplications)
          .where(eq(kycApplications.userId, ctx.user.id))
          .orderBy(desc(kycApplications.createdAt))
          .limit(50);

        return apps;
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to load applications: ${(err as Error).message}`,
        });
      }
    }),

  /**
   * Get the status of a single application by reference ID.
   * Public — no auth required (used by the /status/:refId page).
   */
  getApplicationStatus: publicProcedure
    .input(z.object({ referenceId: z.string().min(1) }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return null;

      try {
        const [app] = await db
          .select({
            referenceId: kycApplications.referenceId,
            type: kycApplications.type,
            status: kycApplications.status,
            kycScore: kycApplications.kycScore,
            reviewNotes: kycApplications.reviewNotes,
            createdAt: kycApplications.createdAt,
            updatedAt: kycApplications.updatedAt,
          })
          .from(kycApplications)
          .where(eq(kycApplications.referenceId, input.referenceId))
          .limit(1);

        return app ?? null;
      } catch (err) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to load application status: ${(err as Error).message}`,
        });
      }
    }),
});
