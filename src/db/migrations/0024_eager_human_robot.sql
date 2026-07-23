ALTER TYPE "public"."update_status" RENAME TO "release_status";--> statement-breakpoint
ALTER TABLE "updates" RENAME TO "releases";--> statement-breakpoint
ALTER TABLE "delivery_attempts" RENAME COLUMN "update_id" TO "release_id";--> statement-breakpoint
ALTER TABLE "atomic_updates" DROP CONSTRAINT "atomic_updates_release_id_updates_id_fk";
--> statement-breakpoint
ALTER TABLE "change_events" DROP CONSTRAINT "change_events_update_id_updates_id_fk";
--> statement-breakpoint
ALTER TABLE "delivery_attempts" DROP CONSTRAINT "delivery_attempts_update_id_updates_id_fk";
--> statement-breakpoint
ALTER TABLE "releases" DROP CONSTRAINT "updates_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "releases" DROP CONSTRAINT "updates_repo_id_repos_id_fk";
--> statement-breakpoint
ALTER TABLE "releases" DROP CONSTRAINT "updates_edited_by_users_id_fk";
--> statement-breakpoint
DROP INDEX "delivery_attempts_update_id_destination_unique";--> statement-breakpoint
ALTER TABLE "atomic_updates" ADD CONSTRAINT "atomic_updates_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_update_id_releases_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attempts_release_id_destination_unique" ON "delivery_attempts" USING btree ("release_id","destination");