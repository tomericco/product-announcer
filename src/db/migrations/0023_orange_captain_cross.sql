CREATE TYPE "public"."atomic_update_status" AS ENUM('open', 'released');--> statement-breakpoint
CREATE TYPE "public"."change_event_provider" AS ENUM('github', 'notion');--> statement-breakpoint
CREATE TYPE "public"."change_event_type" AS ENUM('commit', 'pull_request', 'task');--> statement-breakpoint
CREATE TYPE "public"."filter_reason" AS ENUM('merge_commit', 'empty_diff', 'lockfile_only', 'test_only', 'chore_prefix', 'empty_task');--> statement-breakpoint
CREATE TABLE "atomic_updates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"release_id" uuid,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"category" "update_category",
	"status" "atomic_update_status" DEFAULT 'open' NOT NULL,
	"summary_edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"type" "change_event_type" NOT NULL,
	"provider" "change_event_provider" NOT NULL,
	"external_id" text NOT NULL,
	"external_url" text,
	"atomic_update_id" uuid,
	"status" "change_item_status" DEFAULT 'pending' NOT NULL,
	"filter_reason" "filter_reason",
	"update_id" uuid,
	"excluded_at" timestamp with time zone,
	"excluded_by" uuid,
	"pr_number" integer,
	"pr_title" text,
	"pr_description" text,
	"pr_url" text,
	"merged_at" timestamp with time zone,
	"commit_sha" text,
	"commit_message" text,
	"diff" text,
	"commit_url" text,
	"committed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_facing" boolean,
	"impact_summary" text,
	"suggested_category" "update_category",
	"enrichment_confidence" real,
	"enriched_at" timestamp with time zone
);
--> statement-breakpoint
DROP TABLE "change_items" CASCADE;--> statement-breakpoint
ALTER TABLE "atomic_updates" ADD CONSTRAINT "atomic_updates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_updates" ADD CONSTRAINT "atomic_updates_release_id_updates_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."updates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_atomic_update_id_atomic_updates_id_fk" FOREIGN KEY ("atomic_update_id") REFERENCES "public"."atomic_updates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_update_id_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."updates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_events" ADD CONSTRAINT "change_events_excluded_by_users_id_fk" FOREIGN KEY ("excluded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_events_repo_pr_unique" ON "change_events" USING btree ("repo_id","pr_number");--> statement-breakpoint
CREATE UNIQUE INDEX "change_events_repo_commit_unique" ON "change_events" USING btree ("repo_id","commit_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "change_events_tenant_provider_external_unique" ON "change_events" USING btree ("tenant_id","provider","external_id");--> statement-breakpoint
DROP TYPE "public"."ignored_reason";--> statement-breakpoint
DROP TYPE "public"."source_type";