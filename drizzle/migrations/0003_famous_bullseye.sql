CREATE TYPE "public"."nfc_batch_job_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "nfc_batch_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"jobRef" varchar(32) NOT NULL,
	"submittedBy" integer NOT NULL,
	"totalTags" integer NOT NULL,
	"provisioned" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"status" "nfc_batch_job_status" DEFAULT 'pending' NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"errorMessage" text,
	"durationMs" integer DEFAULT 0 NOT NULL,
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "nfc_batch_jobs_jobRef_unique" UNIQUE("jobRef")
);
--> statement-breakpoint
CREATE INDEX "idx_nfc_batch_submittedBy" ON "nfc_batch_jobs" USING btree ("submittedBy");--> statement-breakpoint
CREATE INDEX "idx_nfc_batch_status" ON "nfc_batch_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_nfc_batch_createdAt" ON "nfc_batch_jobs" USING btree ("createdAt");