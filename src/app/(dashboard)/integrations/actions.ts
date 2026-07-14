"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { webhookConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";

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

  if (existing) {
    await db.update(webhookConfigs).set({ url, secret, active }).where(eq(webhookConfigs.id, existing.id));
  } else {
    await db.insert(webhookConfigs).values({ tenantId: session.user.tenantId, url, secret, active });
  }

  revalidatePath("/integrations");
}
