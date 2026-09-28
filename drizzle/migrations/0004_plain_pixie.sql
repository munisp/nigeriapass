CREATE TYPE "public"."device_status" AS ENUM('online', 'offline', 'warning', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."device_type" AS ENUM('nfc_reader', 'barrier', 'camera', 'display', 'edge_unit');--> statement-breakpoint
CREATE TABLE "toll_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"serial" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"type" "device_type" NOT NULL,
	"plaza" varchar(128) NOT NULL,
	"lane" varchar(64) NOT NULL,
	"status" "device_status" DEFAULT 'offline' NOT NULL,
	"firmware" varchar(32) DEFAULT '1.0.0' NOT NULL,
	"latestFirmware" varchar(32) DEFAULT '1.0.0' NOT NULL,
	"uptime" varchar(32) DEFAULT '0d 0h' NOT NULL,
	"cpu" integer DEFAULT 0 NOT NULL,
	"memory" integer DEFAULT 0 NOT NULL,
	"temp" integer DEFAULT 0 NOT NULL,
	"alerts" integer DEFAULT 0 NOT NULL,
	"lastSeen" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "toll_devices_serial_unique" UNIQUE("serial")
);
--> statement-breakpoint
CREATE INDEX "idx_device_serial" ON "toll_devices" USING btree ("serial");--> statement-breakpoint
CREATE INDEX "idx_device_plaza" ON "toll_devices" USING btree ("plaza");--> statement-breakpoint
CREATE INDEX "idx_device_status" ON "toll_devices" USING btree ("status");