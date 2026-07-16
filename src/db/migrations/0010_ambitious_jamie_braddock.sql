ALTER TABLE "change_items" ADD COLUMN "user_facing" boolean;--> statement-breakpoint
ALTER TABLE "change_items" ADD COLUMN "impact_summary" text;--> statement-breakpoint
ALTER TABLE "change_items" ADD COLUMN "suggested_category" "update_category";--> statement-breakpoint
ALTER TABLE "change_items" ADD COLUMN "enrichment_confidence" real;--> statement-breakpoint
ALTER TABLE "change_items" ADD COLUMN "enriched_at" timestamp with time zone;