ALTER TABLE `connected_accounts` ADD COLUMN `onedrive_delta_link_encrypted` TEXT NULL;
ALTER TABLE `files` ADD COLUMN `provider_version` VARCHAR(191) NULL;
