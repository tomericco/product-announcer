ALTER TABLE "releases" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- DROP TABLE ... CASCADE below already drops the two FK constraints that
-- reference "releases" (atomic_updates_release_id_releases_id_fk and
-- delivery_attempts_release_id_releases_id_fk) as dependent objects, so the
-- generated explicit DROP CONSTRAINT statements for them were removed here —
-- running them afterward fails with "constraint ... does not exist".
DROP TABLE "releases" CASCADE;--> statement-breakpoint
DROP INDEX "delivery_attempts_release_id_destination_unique";--> statement-breakpoint
ALTER TABLE "atomic_updates" DROP COLUMN "release_id";--> statement-breakpoint
ALTER TABLE "delivery_attempts" DROP COLUMN "release_id";--> statement-breakpoint
DROP TYPE "public"."release_status";