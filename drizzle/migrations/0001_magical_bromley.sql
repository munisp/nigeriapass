CREATE TYPE "public"."reconcile_status" AS ENUM('success', 'partial', 'failed', 'empty');--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"triggeredBy" varchar(16) DEFAULT 'scheduled' NOT NULL,
	"status" "reconcile_status" NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"credited" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"durationMs" integer DEFAULT 0 NOT NULL,
	"triggeredByUserId" integer,
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_recon_startedAt" ON "reconciliation_runs" USING btree ("startedAt");--> statement-breakpoint
CREATE INDEX "idx_recon_status" ON "reconciliation_runs" USING btree ("status");