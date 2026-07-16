ALTER TABLE "brand_profiles" DROP COLUMN "user_personas";--> statement-breakpoint
ALTER TABLE "brand_profiles" ADD COLUMN "user_personas" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "auto_publish" boolean DEFAULT false NOT NULL;