ALTER TABLE `transfer_jobs` ADD COLUMN `replication_plan_id` CHAR(36) NULL;
CREATE INDEX `transfer_jobs_replication_plan_id_idx` ON `transfer_jobs`(`replication_plan_id`);
ALTER TABLE `transfer_jobs` ADD CONSTRAINT `transfer_jobs_replication_plan_id_fkey` FOREIGN KEY (`replication_plan_id`) REFERENCES `replication_plans`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
