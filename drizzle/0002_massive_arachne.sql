CREATE TABLE `otp_codes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`phone` varchar(20) NOT NULL,
	`codeHash` varchar(128) NOT NULL,
	`used` boolean NOT NULL DEFAULT false,
	`attempts` int NOT NULL DEFAULT 0,
	`requestIp` varchar(45),
	`messageId` varchar(64),
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `otp_codes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_otp_phone` ON `otp_codes` (`phone`);--> statement-breakpoint
CREATE INDEX `idx_otp_expiresAt` ON `otp_codes` (`expiresAt`);