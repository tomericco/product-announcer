CREATE TYPE "public"."webflow_auth_type" AS ENUM('site_token', 'oauth');--> statement-breakpoint
CREATE TYPE "public"."webflow_connection_status" AS ENUM('active', 'needs_reauth', 'misconfigured');--> statement-breakpoint
CREATE TYPE "public"."webflow_publish_mode" AS ENUM('draft', 'live');--> statement-breakpoint
CREATE TABLE "webflow_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"auth_type" "webflow_auth_type" DEFAULT 'site_token' NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_iv" text NOT NULL,
	"token_auth_tag" text NOT NULL,
	"site_id" text,
	"site_name" text,
	"collection_id" text,
	"collection_name" text,
	"field_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"publish_mode" "webflow_publish_mode" DEFAULT 'draft' NOT NULL,
	"status" "webflow_connection_status" DEFAULT 'active' NOT NULL,
	"last_validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webflow_connections_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
ALTER TABLE "webflow_connections" ADD CONSTRAINT "webflow_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;