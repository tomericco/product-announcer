ALTER TABLE "schedule_configs" DROP CONSTRAINT "schedule_configs_repo_id_repos_id_fk";
--> statement-breakpoint
ALTER TABLE "updates" ALTER COLUMN "repo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_configs" DROP COLUMN "repo_id";--> statement-breakpoint
ALTER TABLE "schedule_configs" ADD CONSTRAINT "schedule_configs_tenant_id_unique" UNIQUE("tenant_id");