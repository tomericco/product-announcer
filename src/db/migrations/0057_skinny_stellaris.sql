CREATE TABLE "brief_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assessment" text,
	"briefs_created" integer DEFAULT 0 NOT NULL,
	"briefs_extended" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "brief_runs" ADD CONSTRAINT "brief_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brief_runs_tenant_ran_at_idx" ON "brief_runs" USING btree ("tenant_id","ran_at");--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_content_piece_id_content_pieces_id_fk" FOREIGN KEY ("content_piece_id") REFERENCES "public"."content_pieces"("id") ON DELETE set null ON UPDATE no action;