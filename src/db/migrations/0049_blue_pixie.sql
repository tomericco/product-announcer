CREATE TYPE "public"."signal_kind" AS ENUM('shipped_work', 'competitor_move', 'market_news', 'manual');--> statement-breakpoint
CREATE TYPE "public"."signal_status" AS ENUM('new', 'used', 'stale');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('active', 'failing', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('competitor_web', 'news');--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_id" uuid,
	"kind" "signal_kind" NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"title" text NOT NULL,
	"excerpt" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"atomic_update_id" uuid,
	"competitor_id" uuid,
	"relevance_score" real,
	"relevance_rationale" text,
	"topics" text[] DEFAULT '{}' NOT NULL,
	"status" "signal_status" DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" "source_type" NOT NULL,
	"competitor_id" uuid,
	"url" text,
	"feed_url" text,
	"label" text NOT NULL,
	"watermark" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "source_status" DEFAULT 'active' NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_atomic_update_id_atomic_updates_id_fk" FOREIGN KEY ("atomic_update_id") REFERENCES "public"."atomic_updates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signals_tenant_kind_external_unique" ON "signals" USING btree ("tenant_id","kind","external_id");--> statement-breakpoint
CREATE INDEX "signals_tenant_occurred_idx" ON "signals" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "signals_tenant_kind_occurred_idx" ON "signals" USING btree ("tenant_id","kind","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_tenant_url_unique" ON "sources" USING btree ("tenant_id","url");