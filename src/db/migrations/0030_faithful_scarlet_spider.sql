CREATE TYPE "public"."atomic_update_size" AS ENUM('s', 'm', 'l', 'xl');--> statement-breakpoint
ALTER TABLE "atomic_updates" ADD COLUMN "size" "atomic_update_size";--> statement-breakpoint
ALTER TABLE "atomic_updates" ADD COLUMN "size_edited_at" timestamp with time zone;