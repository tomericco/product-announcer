CREATE TYPE "public"."destination" AS ENUM('webhook', 'webflow');--> statement-breakpoint
CREATE TABLE "delivery_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"update_id" uuid NOT NULL,
	"destination" "destination" NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"external_id" text,
	"last_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "delivery_attempts" ("id", "update_id", "destination", "status", "attempts", "last_attempt_at", "created_at")
SELECT gen_random_uuid(), "update_id", 'webhook', "status", "attempts", "last_attempt_at", "created_at" FROM "webhook_deliveries";--> statement-breakpoint
DROP TABLE "webhook_deliveries" CASCADE;--> statement-breakpoint
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_update_id_updates_id_fk" FOREIGN KEY ("update_id") REFERENCES "public"."updates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attempts_update_id_destination_unique" ON "delivery_attempts" USING btree ("update_id","destination");