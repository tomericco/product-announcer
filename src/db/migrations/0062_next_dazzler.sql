ALTER TABLE "tenants" ADD COLUMN "week_starts_on" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "holiday_countries" text[] DEFAULT '{}' NOT NULL;