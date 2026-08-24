ALTER TYPE "public"."signal_kind" ADD VALUE 'ai_visibility';--> statement-breakpoint
ALTER TYPE "public"."source_type" ADD VALUE 'ai_visibility';--> statement-breakpoint
CREATE TABLE "ai_visibility_aggregates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"prompt_id" uuid,
	"n" integer NOT NULL,
	"tenant_mentions" integer NOT NULL,
	"competitor_mentions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"own_citations" integer NOT NULL,
	"recommendations" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_visibility_citations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sample_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"url" text NOT NULL,
	"domain" text NOT NULL,
	"position" smallint NOT NULL,
	"domain_class" text NOT NULL,
	"competitor_id" uuid
);
--> statement-breakpoint
CREATE TABLE "ai_visibility_prompts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"text" text NOT NULL,
	"intent" text NOT NULL,
	"persona" text,
	"competitor_id" uuid,
	"branded" boolean DEFAULT false NOT NULL,
	"origin" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"cluster" text,
	"supersedes_id" uuid,
	"flag_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"approved_by" uuid
);
--> statement-breakpoint
CREATE TABLE "ai_visibility_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"trigger" text NOT NULL,
	"engines" text[] NOT NULL,
	"samples_per_prompt" smallint NOT NULL,
	"planned_calls" integer DEFAULT 0 NOT NULL,
	"completed_calls" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"model_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_visibility_samples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"prompt_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"sample_index" smallint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer_text" text,
	"model_id" text,
	"search_used" boolean DEFAULT false NOT NULL,
	"search_queries" text[] DEFAULT '{}' NOT NULL,
	"raw" jsonb,
	"cost_usd" real DEFAULT 0 NOT NULL,
	"error" text,
	"judged" boolean DEFAULT false NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"extraction" jsonb,
	"asked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_visibility_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"cadence" text DEFAULT 'weekly' NOT NULL,
	"day_of_week" smallint DEFAULT 1 NOT NULL,
	"engines" text[] DEFAULT '{"openai","perplexity","gemini","anthropic"}' NOT NULL,
	"samples_per_prompt" smallint DEFAULT 3 NOT NULL,
	"monthly_cap_usd" real DEFAULT 20 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "ai_visibility_aggregates" ADD CONSTRAINT "ai_visibility_aggregates_run_id_ai_visibility_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_visibility_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_aggregates" ADD CONSTRAINT "ai_visibility_aggregates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_aggregates" ADD CONSTRAINT "ai_visibility_aggregates_prompt_id_ai_visibility_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."ai_visibility_prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_citations" ADD CONSTRAINT "ai_visibility_citations_sample_id_ai_visibility_samples_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."ai_visibility_samples"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_citations" ADD CONSTRAINT "ai_visibility_citations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_citations" ADD CONSTRAINT "ai_visibility_citations_run_id_ai_visibility_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_visibility_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_citations" ADD CONSTRAINT "ai_visibility_citations_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_prompts" ADD CONSTRAINT "ai_visibility_prompts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_prompts" ADD CONSTRAINT "ai_visibility_prompts_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_prompts" ADD CONSTRAINT "ai_visibility_prompts_supersedes_id_ai_visibility_prompts_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."ai_visibility_prompts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_prompts" ADD CONSTRAINT "ai_visibility_prompts_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_runs" ADD CONSTRAINT "ai_visibility_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_runs" ADD CONSTRAINT "ai_visibility_runs_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_samples" ADD CONSTRAINT "ai_visibility_samples_run_id_ai_visibility_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_visibility_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_samples" ADD CONSTRAINT "ai_visibility_samples_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_samples" ADD CONSTRAINT "ai_visibility_samples_prompt_id_ai_visibility_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."ai_visibility_prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_settings" ADD CONSTRAINT "ai_visibility_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_visibility_aggregates_run_engine_prompt_unique" ON "ai_visibility_aggregates" USING btree ("run_id","engine","prompt_id") WHERE "ai_visibility_aggregates"."prompt_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_visibility_aggregates_run_engine_null_prompt_unique" ON "ai_visibility_aggregates" USING btree ("run_id","engine") WHERE "ai_visibility_aggregates"."prompt_id" IS NULL;--> statement-breakpoint
CREATE INDEX "ai_visibility_citations_tenant_domain_idx" ON "ai_visibility_citations" USING btree ("tenant_id","domain");--> statement-breakpoint
CREATE INDEX "ai_visibility_citations_run_domain_idx" ON "ai_visibility_citations" USING btree ("run_id","domain");--> statement-breakpoint
CREATE INDEX "ai_visibility_prompts_tenant_status_idx" ON "ai_visibility_prompts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_visibility_prompts_tenant_text_unique" ON "ai_visibility_prompts" USING btree ("tenant_id","text") WHERE "ai_visibility_prompts"."status" <> 'rejected';--> statement-breakpoint
CREATE INDEX "ai_visibility_runs_tenant_started_idx" ON "ai_visibility_runs" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_visibility_samples_identity_unique" ON "ai_visibility_samples" USING btree ("run_id","prompt_id","engine","sample_index");--> statement-breakpoint
CREATE INDEX "ai_visibility_samples_run_status_idx" ON "ai_visibility_samples" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "ai_visibility_samples_tenant_prompt_engine_idx" ON "ai_visibility_samples" USING btree ("tenant_id","prompt_id","engine");