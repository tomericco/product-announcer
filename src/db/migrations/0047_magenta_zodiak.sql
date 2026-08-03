ALTER TABLE "schedule_configs" DROP COLUMN "cadence";--> statement-breakpoint
ALTER TABLE "schedule_configs" DROP COLUMN "threshold";--> statement-breakpoint
ALTER TABLE "schedule_configs" DROP COLUMN "threshold_enabled";--> statement-breakpoint
ALTER TABLE "schedule_configs" DROP COLUMN "day_of_week";--> statement-breakpoint
ALTER TABLE "schedule_configs" DROP COLUMN "day_of_month";--> statement-breakpoint
DROP TYPE "public"."cadence";