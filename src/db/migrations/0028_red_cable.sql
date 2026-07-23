ALTER TABLE "webhook_configs" ALTER COLUMN "secret_ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_configs" ALTER COLUMN "secret_iv" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_configs" ALTER COLUMN "secret_auth_tag" DROP NOT NULL;