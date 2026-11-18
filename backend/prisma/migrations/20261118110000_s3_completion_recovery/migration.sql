ALTER TABLE `upload_sessions`
  ADD COLUMN `completion_lease_expires_at` DATETIME(3) NULL;
