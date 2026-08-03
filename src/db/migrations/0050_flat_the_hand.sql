DROP INDEX "sources_tenant_url_unique";--> statement-breakpoint
CREATE INDEX "signals_tenant_created_idx" ON "signals" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_tenant_url_unique" ON "sources" USING btree ("tenant_id","url") WHERE "sources"."url" IS NOT NULL;