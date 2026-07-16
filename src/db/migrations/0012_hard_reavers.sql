CREATE TYPE "public"."review_status" AS ENUM('passed', 'revised', 'failed', 'error');--> statement-breakpoint
ALTER TABLE "updates" ADD COLUMN "review_status" "review_status";--> statement-breakpoint
ALTER TABLE "updates" ADD COLUMN "review_issues" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "updates" ADD COLUMN "reviewed_at" timestamp with time zone;