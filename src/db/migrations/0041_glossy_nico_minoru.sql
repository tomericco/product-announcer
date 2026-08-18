CREATE TABLE "channel_variants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"content_piece_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"body" text NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_variants" ADD CONSTRAINT "channel_variants_content_piece_id_content_pieces_id_fk" FOREIGN KEY ("content_piece_id") REFERENCES "public"."content_pieces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_variants_piece_channel_unique" ON "channel_variants" USING btree ("content_piece_id","channel");