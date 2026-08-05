CREATE TYPE "public"."brief_dismiss_reason" AS ENUM('off_topic', 'wrong_angle', 'already_covered', 'not_our_voice', 'other');--> statement-breakpoint
CREATE TYPE "public"."brief_origin" AS ENUM('agent', 'manual');--> statement-breakpoint
CREATE TYPE "public"."brief_status" AS ENUM('new', 'accepted', 'dismissed', 'expired');--> statement-breakpoint
CREATE TABLE "brief_signals" (
	"brief_id" uuid NOT NULL,
	"signal_id" uuid NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brief_signals_brief_id_signal_id_pk" PRIMARY KEY("brief_id","signal_id")
);
--> statement-breakpoint
CREATE TABLE "briefs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"origin" "brief_origin" NOT NULL,
	"created_by" uuid,
	"content_type" "content_type" NOT NULL,
	"title" text NOT NULL,
	"angle" text NOT NULL,
	"why_now" text NOT NULL,
	"suggested_channel" text NOT NULL,
	"audience" text,
	"key_points" text[] DEFAULT '{}' NOT NULL,
	"target_length" integer,
	"score" real NOT NULL,
	"score_rationale" text,
	"status" "brief_status" DEFAULT 'new' NOT NULL,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone,
	"content_piece_id" uuid,
	"dismiss_reason" "brief_dismiss_reason",
	"dismiss_note" text,
	"dismissed_by" uuid,
	"dismissed_at" timestamp with time zone,
	"edited_at" timestamp with time zone,
	"last_evidence_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brief_signals" ADD CONSTRAINT "brief_signals_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_signals" ADD CONSTRAINT "brief_signals_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_signals" ADD CONSTRAINT "brief_signals_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "briefs_tenant_status_score_idx" ON "briefs" USING btree ("tenant_id","status","score");--> statement-breakpoint
CREATE INDEX "briefs_tenant_status_expires_idx" ON "briefs" USING btree ("tenant_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "briefs_content_piece_unique" ON "briefs" USING btree ("content_piece_id") WHERE "briefs"."content_piece_id" IS NOT NULL;