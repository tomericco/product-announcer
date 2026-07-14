CREATE TYPE "public"."cadence" AS ENUM('daily', 'weekly', 'biweekly', 'monthly', 'none');--> statement-breakpoint
CREATE TYPE "public"."update_category" AS ENUM('new', 'improved', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."update_status" AS ENUM('draft', 'approved', 'published', 'rejected');--> statement-breakpoint
CREATE TABLE "brand_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"tone" text,
	"reading_level" text,
	"do_list" text[] DEFAULT '{}' NOT NULL,
	"dont_list" text[] DEFAULT '{}' NOT NULL,
	"example_phrases" text[] DEFAULT '{}' NOT NULL,
	"industry" text,
	"user_personas" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_profiles_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
CREATE TABLE "schedule_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"cadence" "cadence" DEFAULT 'weekly' NOT NULL,
	"threshold" integer,
	"last_run_at" timestamp with time zone,
	"next_scheduled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "updates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" "update_category" NOT NULL,
	"status" "update_status" DEFAULT 'draft' NOT NULL,
	"source_items" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"edited_by" uuid
);
--> statement-breakpoint
ALTER TABLE "brand_profiles" ADD CONSTRAINT "brand_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_configs" ADD CONSTRAINT "schedule_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_configs" ADD CONSTRAINT "schedule_configs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "updates" ADD CONSTRAINT "updates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "updates" ADD CONSTRAINT "updates_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "updates" ADD CONSTRAINT "updates_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_items" ADD CONSTRAINT "change_items_update_id_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."updates"("id") ON DELETE no action ON UPDATE no action;