CREATE TABLE "content_images" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"content_piece_id" uuid,
	"role" text NOT NULL,
	"concept" text NOT NULL,
	"alt_text" text NOT NULL,
	"source_kind" text NOT NULL,
	"status" text NOT NULL,
	"current_render_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_renders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"image_id" uuid NOT NULL,
	"prompt" text NOT NULL,
	"blob_url" text NOT NULL,
	"blob_pathname" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_profiles" ADD COLUMN "visual_identity" jsonb;--> statement-breakpoint
ALTER TABLE "company_profiles" ADD COLUMN "image_policy" jsonb;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "image_count" integer;--> statement-breakpoint
ALTER TABLE "content_images" ADD CONSTRAINT "content_images_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_images" ADD CONSTRAINT "content_images_content_piece_id_content_pieces_id_fk" FOREIGN KEY ("content_piece_id") REFERENCES "public"."content_pieces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_renders" ADD CONSTRAINT "image_renders_image_id_content_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."content_images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_images_tenant_created_idx" ON "content_images" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "content_images_cover_unique" ON "content_images" USING btree ("content_piece_id") WHERE "content_images"."role" = 'cover';--> statement-breakpoint
CREATE INDEX "image_renders_image_created_idx" ON "image_renders" USING btree ("image_id","created_at");