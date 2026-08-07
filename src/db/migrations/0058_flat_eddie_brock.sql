ALTER TABLE "content_pieces" ADD COLUMN "generation_error" text;--> statement-breakpoint
ALTER TABLE "content_pieces" ADD COLUMN "generated_at" timestamp with time zone;