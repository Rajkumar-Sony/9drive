ALTER TABLE `upload_sessions`
  ADD COLUMN `provider_session_data` JSON NULL,
  ADD COLUMN `relative_path` TEXT NULL;

CREATE TABLE `transfer_jobs` (
  `id` CHAR(36) NOT NULL, `user_id` CHAR(36) NOT NULL, `kind` VARCHAR(24) NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'queued', `source_connected_account_id` CHAR(36) NOT NULL,
  `destination_connected_account_id` CHAR(36) NOT NULL, `conflict_policy` VARCHAR(24) NOT NULL DEFAULT 'keep_both',
  `priority` INT NOT NULL DEFAULT 0, `total_items` INT NOT NULL DEFAULT 0,
  `completed_items` INT NOT NULL DEFAULT 0, `failed_items` INT NOT NULL DEFAULT 0,
  `attempt_count` INT NOT NULL DEFAULT 0, `max_attempts` INT NOT NULL DEFAULT 5,
  `available_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `lease_owner` VARCHAR(191) NULL,
  `lease_expires_at` DATETIME(3) NULL, `fencing_token` BIGINT NOT NULL DEFAULT 0,
  `cancel_requested_at` DATETIME(3) NULL, `last_error` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` DATETIME(3) NOT NULL,
  `started_at` DATETIME(3) NULL, `completed_at` DATETIME(3) NULL,
  INDEX `transfer_jobs_status_available_at_priority_created_at_idx` (`status`,`available_at`,`priority`,`created_at`),
  INDEX `transfer_jobs_user_id_created_at_idx` (`user_id`,`created_at`), INDEX `transfer_jobs_lease_expires_at_idx` (`lease_expires_at`),
  PRIMARY KEY (`id`),
  CONSTRAINT `transfer_jobs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `transfer_jobs_source_connected_account_id_fkey` FOREIGN KEY (`source_connected_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `transfer_jobs_destination_connected_account_id_fkey` FOREIGN KEY (`destination_connected_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `transfer_job_items` (
  `id` CHAR(36) NOT NULL, `job_id` CHAR(36) NOT NULL, `source_file_id` CHAR(36) NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'queued', `source_provider_id` VARCHAR(191) NOT NULL,
  `destination_provider_id` VARCHAR(191) NULL, `destination_file_id` CHAR(36) NULL,
  `destination_name` VARCHAR(255) NOT NULL, `size_bytes` BIGINT NOT NULL, `checksum` VARCHAR(191) NULL,
  `bytes_transferred` BIGINT NOT NULL DEFAULT 0, `attempt_count` INT NOT NULL DEFAULT 0,
  `last_error` TEXT NULL, `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL, `completed_at` DATETIME(3) NULL,
  UNIQUE INDEX `transfer_job_items_job_id_source_file_id_key` (`job_id`,`source_file_id`),
  INDEX `transfer_job_items_job_id_status_created_at_idx` (`job_id`,`status`,`created_at`),
  INDEX `transfer_job_items_source_file_id_idx` (`source_file_id`), PRIMARY KEY (`id`),
  CONSTRAINT `transfer_job_items_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `transfer_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `transfer_job_items_source_file_id_fkey` FOREIGN KEY (`source_file_id`) REFERENCES `files`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `replication_plans` (
  `id` CHAR(36) NOT NULL, `user_id` CHAR(36) NOT NULL, `source_connected_account_id` CHAR(36) NOT NULL,
  `destination_connected_account_id` CHAR(36) NOT NULL, `name` VARCHAR(191) NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'active', `schedule_cron` VARCHAR(100) NULL,
  `last_run_at` DATETIME(3) NULL, `next_run_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` DATETIME(3) NOT NULL,
  INDEX `replication_plans_user_id_status_idx` (`user_id`,`status`), INDEX `replication_plans_status_next_run_at_idx` (`status`,`next_run_at`), PRIMARY KEY (`id`),
  CONSTRAINT `replication_plans_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `replication_plans_source_connected_account_id_fkey` FOREIGN KEY (`source_connected_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `replication_plans_destination_connected_account_id_fkey` FOREIGN KEY (`destination_connected_account_id`) REFERENCES `connected_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `replication_mappings` (
  `id` CHAR(36) NOT NULL, `plan_id` CHAR(36) NOT NULL, `source_provider_id` VARCHAR(191) NOT NULL,
  `destination_provider_id` VARCHAR(191) NOT NULL, `source_version` VARCHAR(191) NULL,
  `checksum` VARCHAR(191) NULL, `last_replicated_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `replication_mappings_plan_id_source_provider_id_key` (`plan_id`,`source_provider_id`),
  INDEX `replication_mappings_destination_provider_id_idx` (`destination_provider_id`), PRIMARY KEY (`id`),
  CONSTRAINT `replication_mappings_plan_id_fkey` FOREIGN KEY (`plan_id`) REFERENCES `replication_plans`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `vault_objects` (
  `id` CHAR(36) NOT NULL, `user_id` CHAR(36) NOT NULL, `file_id` CHAR(36) NOT NULL,
  `format_version` INT NOT NULL DEFAULT 1, `encrypted_metadata` LONGBLOB NOT NULL,
  `salt` VARBINARY(64) NOT NULL, `key_wrap` LONGBLOB NOT NULL, `encryption_algorithm` VARCHAR(64) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `vault_objects_file_id_key` (`file_id`), INDEX `vault_objects_user_id_created_at_idx` (`user_id`,`created_at`), PRIMARY KEY (`id`),
  CONSTRAINT `vault_objects_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `vault_objects_file_id_fkey` FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
