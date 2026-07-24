CREATE TYPE "public"."notion_connection_status" AS ENUM('active', 'needs_reauth', 'misconfigured');--> statement-breakpoint
CREATE TABLE "notion_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"access_token_ciphertext" text NOT NULL,
	"access_token_iv" text NOT NULL,
	"access_token_auth_tag" text NOT NULL,
	"refresh_token_ciphertext" text,
	"refresh_token_iv" text,
	"refresh_token_auth_tag" text,
	"workspace_id" text NOT NULL,
	"bot_id" text,
	"database_id" text,
	"database_name" text,
	"status_property_id" text,
	"status_property_name" text,
	"done_values" text[] DEFAULT '{}' NOT NULL,
	"status" "notion_connection_status" DEFAULT 'misconfigured' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notion_connections_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
ALTER TABLE "change_events" ALTER COLUMN "repo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "change_events" ADD COLUMN "task_title" text;--> statement-breakpoint
ALTER TABLE "change_events" ADD COLUMN "task_description" text;--> statement-breakpoint
ALTER TABLE "change_events" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notion_connections" ADD CONSTRAINT "notion_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notion_connections_workspace_idx" ON "notion_connections" USING btree ("workspace_id");