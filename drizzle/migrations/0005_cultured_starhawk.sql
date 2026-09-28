CREATE TABLE "device_alert_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"deviceId" integer NOT NULL,
	"serial" varchar(64) NOT NULL,
	"plaza" varchar(128) NOT NULL,
	"alertsCleared" integer DEFAULT 0 NOT NULL,
	"note" text,
	"resolvedByUserId" integer NOT NULL,
	"resolvedByName" varchar(128),
	"resolvedAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_dal_deviceId" ON "device_alert_logs" USING btree ("deviceId");--> statement-breakpoint
CREATE INDEX "idx_dal_serial" ON "device_alert_logs" USING btree ("serial");--> statement-breakpoint
CREATE INDEX "idx_dal_resolvedAt" ON "device_alert_logs" USING btree ("resolvedAt");