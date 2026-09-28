CREATE TABLE `kyc_applications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`referenceId` varchar(32) NOT NULL,
	`userId` int,
	`type` enum('driver','vehicle','fleet') NOT NULL,
	`status` enum('draft','submitted','under_review','approved','rejected','requires_resubmission') NOT NULL DEFAULT 'draft',
	`formData` json NOT NULL,
	`kycScore` int,
	`reviewNotes` text,
	`reviewedBy` int,
	`reviewedAt` timestamp,
	`fromOfflineQueue` boolean NOT NULL DEFAULT false,
	`clientVersion` int NOT NULL DEFAULT 1,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `kyc_applications_id` PRIMARY KEY(`id`),
	CONSTRAINT `kyc_applications_referenceId_unique` UNIQUE(`referenceId`)
);
--> statement-breakpoint
CREATE TABLE `sync_queue` (
	`id` int AUTO_INCREMENT NOT NULL,
	`clientId` varchar(64) NOT NULL,
	`userId` int,
	`procedure` varchar(128) NOT NULL,
	`payload` json NOT NULL,
	`status` enum('pending','processing','done','failed') NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`lastError` text,
	`queuedAt` timestamp NOT NULL,
	`processedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sync_queue_id` PRIMARY KEY(`id`),
	CONSTRAINT `sync_queue_clientId_unique` UNIQUE(`clientId`)
);
--> statement-breakpoint
CREATE TABLE `wallet_accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`tigerBeetleId` varchar(40) NOT NULL,
	`balanceKobo` bigint NOT NULL DEFAULT 0,
	`dailyCapKobo` bigint NOT NULL DEFAULT 500000,
	`dailySpentKobo` bigint NOT NULL DEFAULT 0,
	`lastBalanceSync` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `wallet_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `wallet_accounts_userId_unique` UNIQUE(`userId`),
	CONSTRAINT `wallet_accounts_tigerBeetleId_unique` UNIQUE(`tigerBeetleId`)
);
--> statement-breakpoint
CREATE TABLE `wallet_transactions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`walletId` int NOT NULL,
	`type` enum('topup','toll_charge','refund','adjustment') NOT NULL,
	`amountKobo` bigint NOT NULL,
	`balanceAfterKobo` bigint NOT NULL,
	`description` text,
	`externalRef` varchar(128),
	`plazaId` varchar(32),
	`tigerBeetleTransferId` varchar(40),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `wallet_transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_kyc_userId` ON `kyc_applications` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_kyc_status` ON `kyc_applications` (`status`);--> statement-breakpoint
CREATE INDEX `idx_kyc_type` ON `kyc_applications` (`type`);--> statement-breakpoint
CREATE INDEX `idx_sq_status` ON `sync_queue` (`status`);--> statement-breakpoint
CREATE INDEX `idx_sq_userId` ON `sync_queue` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_wallet_userId` ON `wallet_accounts` (`userId`);--> statement-breakpoint
CREATE INDEX `idx_wtx_walletId` ON `wallet_transactions` (`walletId`);--> statement-breakpoint
CREATE INDEX `idx_wtx_type` ON `wallet_transactions` (`type`);--> statement-breakpoint
CREATE INDEX `idx_wtx_createdAt` ON `wallet_transactions` (`createdAt`);