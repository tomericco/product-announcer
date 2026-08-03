CREATE TYPE "public"."content_piece_status" AS ENUM('brief', 'draft', 'review', 'scheduled', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."content_type" AS ENUM('product_update', 'blog_post', 'social_post');--> statement-breakpoint
CREATE TABLE "content_pieces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"repo_id" uuid,
	"type" "content_type" DEFAULT 'product_update' NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" "content_piece_status" DEFAULT 'draft' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"assigned_to" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"edited_by" uuid,
	"published_by" uuid,
	"review_status" "review_status",
	"review_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviewed_at" timestamp with time zone,
	"composed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"body_edited_at" timestamp with time zone,
	"linkedin_body" text,
	"linkedin_body_edited_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "atomic_updates" ADD COLUMN "content_piece_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD COLUMN "content_piece_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "content_pieces" ADD CONSTRAINT "content_pieces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_pieces" ADD CONSTRAINT "content_pieces_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_pieces" ADD CONSTRAINT "content_pieces_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_pieces" ADD CONSTRAINT "content_pieces_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_pieces" ADD CONSTRAINT "content_pieces_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "atomic_updates" ADD CONSTRAINT "atomic_updates_content_piece_id_content_pieces_id_fk" FOREIGN KEY ("content_piece_id") REFERENCES "public"."content_pieces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_content_piece_id_content_pieces_id_fk" FOREIGN KEY ("content_piece_id") REFERENCES "public"."content_pieces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attempts_content_piece_destination_unique" ON "delivery_attempts" USING btree ("content_piece_id","destination");