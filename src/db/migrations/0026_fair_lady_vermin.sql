ALTER TABLE "releases" ADD COLUMN "composed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "body_edited_at" timestamp with time zone;