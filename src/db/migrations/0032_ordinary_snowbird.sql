CREATE TYPE "public"."linkedin_connection_status" AS ENUM('active', 'needs_reauth', 'misconfigured');--> statement-breakpoint
ALTER TYPE "public"."destination" ADD VALUE 'linkedin';--> statement-breakpoint
CREATE TABLE "linkedin_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"access_token_ciphertext" text NOT NULL,
	"access_token_iv" text NOT NULL,
	"access_token_auth_tag" text NOT NULL,
	"refresh_token_ciphertext" text,
	"refresh_token_iv" text,
	"refresh_token_auth_tag" text,
	"expires_at" timestamp with time zone NOT NULL,
	"organization_urn" text,
	"organization_name" text,
	"base_url" text,
	"status" "linkedin_connection_status" DEFAULT 'active' NOT NULL,
	"last_validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linkedin_connections_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "linkedin_body" text;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "linkedin_body_edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "linkedin_connections" ADD CONSTRAINT "linkedin_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;