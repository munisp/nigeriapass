CREATE TABLE "qr_scan_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"deviceSerial" varchar(64) NOT NULL,
	"scannedUri" text NOT NULL,
	"valid" boolean NOT NULL,
	"rejectionReason" varchar(128),
	"plazaName" varchar(128),
	"lane" varchar(32),
	"operatorUserId" integer,
	"operatorName" varchar(128),
	"scannedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_qr_scan_deviceSerial" ON "qr_scan_logs" USING btree ("deviceSerial");--> statement-breakpoint
CREATE INDEX "idx_qr_scan_valid" ON "qr_scan_logs" USING btree ("valid");--> statement-breakpoint
CREATE INDEX "idx_qr_scan_scannedAt" ON "qr_scan_logs" USING btree ("scannedAt");--> statement-breakpoint
CREATE INDEX "idx_qr_scan_operatorUserId" ON "qr_scan_logs" USING btree ("operatorUserId");