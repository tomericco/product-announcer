CREATE TYPE "public"."ignored_reason" AS ENUM('merge_commit', 'empty_diff');--> statement-breakpoint
ALTER TYPE "public"."change_item_status" ADD VALUE 'ignored';--> statement-breakpoint
ALTER TABLE "change_items" ADD COLUMN "ignored_reason" "ignored_reason";