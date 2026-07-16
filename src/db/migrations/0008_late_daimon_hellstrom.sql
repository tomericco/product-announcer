ALTER TABLE "schedule_configs" ADD COLUMN "hour" integer DEFAULT 9 NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_configs" ADD COLUMN "day_of_week" integer;--> statement-breakpoint
ALTER TABLE "schedule_configs" ADD COLUMN "day_of_month" integer;