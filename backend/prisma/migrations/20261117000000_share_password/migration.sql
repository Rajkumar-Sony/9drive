ALTER TABLE `file_shares` ADD COLUMN `password_hash` TEXT NULL;
ALTER TABLE `file_shares` ADD COLUMN `password_version` INTEGER NOT NULL DEFAULT 0;

CREATE TABLE `share_password_attempts` (
  `key_hash` CHAR(64) NOT NULL,
  `count` INTEGER NOT NULL DEFAULT 0,
  `reset_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`key_hash`)
);

CREATE INDEX `share_password_attempts_reset_at_idx` ON `share_password_attempts`(`reset_at`);
