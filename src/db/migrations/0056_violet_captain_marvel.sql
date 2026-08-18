CREATE TYPE "public"."rejected_article_reason" AS ENUM('not_selected', 'stale');--> statement-breakpoint
CREATE TABLE "rejected_articles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"reason" "rejected_article_reason" NOT NULL,
	"rejected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rejected_articles" ADD CONSTRAINT "rejected_articles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rejected_articles_tenant_url_unique" ON "rejected_articles" USING btree ("tenant_id","url");