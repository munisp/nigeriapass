CREATE TYPE "public"."kyc_status" AS ENUM('draft', 'submitted', 'under_review', 'approved', 'rejected', 'requires_resubmission');--> statement-breakpoint
CREATE TYPE "public"."kyc_type" AS ENUM('driver', 'vehicle', 'fleet');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('pending', 'processing', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."tx_type" AS ENUM('topup', 'toll_charge', 'refund', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "kyc_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"referenceId" varchar(32) NOT NULL,
	"userId" integer,
	"type" "kyc_type" NOT NULL,
	"status" "kyc_status" DEFAULT 'draft' NOT NULL,
	"formData" jsonb NOT NULL,
	"kycScore" integer,
	"reviewNotes" text,
	"reviewedBy" integer,
	"reviewedAt" timestamp,
	"fromOfflineQueue" boolean DEFAULT false NOT NULL,
	"clientVersion" integer DEFAULT 1 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "kyc_applications_referenceId_unique" UNIQUE("referenceId")
);
--> statement-breakpoint
CREATE TABLE "otp_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone" varchar(20) NOT NULL,
	"codeHash" varchar(128) NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"requestIp" varchar(45),
	"messageId" varchar(64),
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"clientId" varchar(64) NOT NULL,
	"userId" integer,
	"procedure" varchar(128) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "sync_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lastError" text,
	"queuedAt" timestamp NOT NULL,
	"processedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sync_queue_clientId_unique" UNIQUE("clientId")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"openId" varchar(64) NOT NULL,
	"name" text,
	"email" varchar(320),
	"loginMethod" varchar(64),
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"lastSignedIn" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_openId_unique" UNIQUE("openId")
);
--> statement-breakpoint
CREATE TABLE "wallet_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"tigerBeetleId" varchar(40) NOT NULL,
	"balanceKobo" bigint DEFAULT 0 NOT NULL,
	"dailyCapKobo" bigint DEFAULT 500000 NOT NULL,
	"dailySpentKobo" bigint DEFAULT 0 NOT NULL,
	"lastBalanceSync" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_accounts_userId_unique" UNIQUE("userId"),
	CONSTRAINT "wallet_accounts_tigerBeetleId_unique" UNIQUE("tigerBeetleId")
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"walletId" integer NOT NULL,
	"type" "tx_type" NOT NULL,
	"amountKobo" bigint NOT NULL,
	"balanceAfterKobo" bigint NOT NULL,
	"description" text,
	"externalRef" varchar(128),
	"plazaId" varchar(32),
	"tigerBeetleTransferId" varchar(40),
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_kyc_userId" ON "kyc_applications" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "idx_kyc_status" ON "kyc_applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_kyc_type" ON "kyc_applications" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_otp_phone" ON "otp_codes" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "idx_otp_expiresAt" ON "otp_codes" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "idx_sq_status" ON "sync_queue" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_sq_userId" ON "sync_queue" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "idx_wallet_userId" ON "wallet_accounts" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "idx_wtx_walletId" ON "wallet_transactions" USING btree ("walletId");--> statement-breakpoint
CREATE INDEX "idx_wtx_type" ON "wallet_transactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_wtx_createdAt" ON "wallet_transactions" USING btree ("createdAt");