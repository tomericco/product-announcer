CREATE TYPE "public"."change_item_status" AS ENUM('pending', 'batched', 'excluded');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('pr', 'commit');--> statement-breakpoint
CREATE TABLE "change_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"source_type" "source_type" NOT NULL,
	"status" "change_item_status" DEFAULT 'pending' NOT NULL,
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"github_repo_full_name" text NOT NULL,
	"github_installation_id" text NOT NULL,
	"watched_branch" text NOT NULL,
	"source_types" text[] DEFAULT '{"pr"}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "github_installation_id" text;--> statement-breakpoint
ALTER TABLE "change_items" ADD CONSTRAINT "change_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_items" ADD CONSTRAINT "change_items_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_items" ADD CONSTRAINT "change_items_excluded_by_users_id_fk" FOREIGN KEY ("excluded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;