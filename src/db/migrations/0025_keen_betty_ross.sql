ALTER TABLE "change_events" DROP CONSTRAINT "change_events_update_id_releases_id_fk";
--> statement-breakpoint
ALTER TABLE "change_events" DROP COLUMN "update_id";--> statement-breakpoint
ALTER TABLE "releases" DROP COLUMN "source_items";--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN "auto_publish";