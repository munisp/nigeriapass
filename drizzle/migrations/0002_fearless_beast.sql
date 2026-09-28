ALTER TABLE "reconciliation_runs" ADD COLUMN "resolvedAt" timestamp;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD COLUMN "resolvedNote" varchar(500);--> statement-breakpoint
CREATE INDEX "idx_recon_resolvedAt" ON "reconciliation_runs" USING btree ("resolvedAt");