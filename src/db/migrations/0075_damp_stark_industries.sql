CREATE TABLE "ai_visibility_engine_key_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"action" text NOT NULL,
	"last4" text,
	"status" text,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_visibility_engine_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"key_ciphertext" text NOT NULL,
	"key_iv" text NOT NULL,
	"key_auth_tag" text NOT NULL,
	"last4" text NOT NULL,
	"status" text DEFAULT 'verified' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"verified_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_failure_code" text,
	"last_failure_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "ai_visibility_engine_key_events" ADD CONSTRAINT "ai_visibility_engine_key_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_engine_key_events" ADD CONSTRAINT "ai_visibility_engine_key_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_engine_keys" ADD CONSTRAINT "ai_visibility_engine_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_engine_keys" ADD CONSTRAINT "ai_visibility_engine_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_visibility_engine_key_events_tenant_idx" ON "ai_visibility_engine_key_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_visibility_engine_keys_tenant_engine_unique" ON "ai_visibility_engine_keys" USING btree ("tenant_id","engine");