ALTER TABLE "updates" ALTER COLUMN "review_status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."review_status";--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('passed', 'failed', 'error');--> statement-breakpoint
ALTER TABLE "updates" ALTER COLUMN "review_status" SET DATA TYPE "public"."review_status" USING "review_status"::"public"."review_status";