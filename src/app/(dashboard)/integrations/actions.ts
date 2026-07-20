"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { webhookConfigs } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { encryptSecret } from "@/lib/credentials/encryption";

export async function saveWebhookConfig(formData: FormData) {
  const session = await requireSession();
  const url = formData.get("url") as string;
  const secret = formData.get("secret") as string;
  const active = formData.get("active") === "on";

  const [existing] = await db
    .select()
    .from(webhookConfigs)
    .where(eq(webhookConfigs.tenantId, session.user.tenantId))
    .limit(1);

  // The form is write-only: an empty secret on an existing config means
  // "leave it alone", not "set it to empty".
  const encrypted = secret ? encryptSecret(secret) : null;

  if (existing) {
    await db
      .update(webhookConfigs)
      .set({
        url,
        active,
        ...(encrypted
          ? {
              secretCiphertext: encrypted.ciphertext,
              secretIv: encrypted.iv,
              secretAuthTag: encrypted.authTag,
            }
          : {}),
      })
      .where(eq(webhookConfigs.id, existing.id));
  } else {
    if (!encrypted) throw new Error("A secret is required to create a webhook config");
    await db.insert(webhookConfigs).values({
      tenantId: session.user.tenantId,
      url,
      active,
      secretCiphertext: encrypted.ciphertext,
      secretIv: encrypted.iv,
      secretAuthTag: encrypted.authTag,
    });
  }

  revalidatePath("/integrations");
}
