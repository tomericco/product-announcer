ALTER TABLE "webhook_configs" ADD COLUMN "secret_ciphertext" text;--> statement-breakpoint
ALTER TABLE "webhook_configs" ADD COLUMN "secret_iv" text;--> statement-breakpoint
ALTER TABLE "webhook_configs" ADD COLUMN "secret_auth_tag" text;--> statement-breakpoint
-- Existing plaintext secrets cannot be encrypted from SQL, and the columns are
-- about to become NOT NULL. Drop those rows; the owner re-enters the secret.
DELETE FROM "webhook_configs" WHERE "secret_ciphertext" IS NULL;--> statement-breakpoint
ALTER TABLE "webhook_configs" ALTER COLUMN "secret_ciphertext" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_configs" ALTER COLUMN "secret_iv" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_configs" ALTER COLUMN "secret_auth_tag" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_configs" DROP COLUMN "secret";
