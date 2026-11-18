ALTER TABLE `connected_accounts` ADD COLUMN `telegram_session_encrypted` TEXT NULL;
ALTER TABLE `files` MODIFY `provider_file_id` VARCHAR(512) NOT NULL;

CREATE TABLE `telegram_auth_challenges` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `phone_encrypted` TEXT NOT NULL,
  `phone_code_hash_encrypted` TEXT NOT NULL,
  `session_encrypted` TEXT NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'awaiting_code',
  `attempt_count` INTEGER NOT NULL DEFAULT 0,
  `expires_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  INDEX `telegram_auth_challenges_user_id_expires_at_idx` (`user_id`, `expires_at`),
  PRIMARY KEY (`id`),
  CONSTRAINT `telegram_auth_challenges_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
