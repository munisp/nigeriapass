CREATE TABLE "ussd_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"sessionId" varchar(128) NOT NULL,
	"phoneNumber" varchar(32) NOT NULL,
	"serviceCode" varchar(32),
	"menuPath" text,
	"completed" boolean DEFAULT false NOT NULL,
	"interactionCount" integer DEFAULT 0 NOT NULL,
	"durationSeconds" integer,
	"countryCode" varchar(4),
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"endedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ussd_sessions_sessionId_unique" UNIQUE("sessionId")
);
--> statement-breakpoint
CREATE INDEX "idx_ussd_sessionId" ON "ussd_sessions" USING btree ("sessionId");--> statement-breakpoint
CREATE INDEX "idx_ussd_phoneNumber" ON "ussd_sessions" USING btree ("phoneNumber");--> statement-breakpoint
CREATE INDEX "idx_ussd_startedAt" ON "ussd_sessions" USING btree ("startedAt");--> statement-breakpoint
CREATE INDEX "idx_ussd_completed" ON "ussd_sessions" USING btree ("completed");