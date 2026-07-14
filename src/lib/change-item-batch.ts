import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { changeItems, updates } from "../db/schema";

type ChangeItemRow = typeof changeItems.$inferSelect;
type UpdateRow = typeof updates.$inferSelect;

export async function getPendingChangeItems(
  repoId: string,
  database: typeof defaultDb = defaultDb
): Promise<ChangeItemRow[]> {
  return database
    .select()
    .from(changeItems)
    .where(and(eq(changeItems.repoId, repoId), eq(changeItems.status, "pending")))
    .orderBy(changeItems.createdAt);
}

export type DraftInput = { title: string; body: string; category: "new" | "improved" | "fixed" };

export async function claimBatchAndCreateUpdate(
  input: { tenantId: string; repoId: string; changeItemIds: string[]; draft: DraftInput },
  database: typeof defaultDb = defaultDb
): Promise<UpdateRow | null> {
  return database.transaction(async (tx) => {
    const claimed = await tx
      .update(changeItems)
      .set({ status: "batched" })
      .where(and(inArray(changeItems.id, input.changeItemIds), eq(changeItems.status, "pending")))
      .returning({ id: changeItems.id });

    if (claimed.length === 0) return null;

    const claimedIds = claimed.map((c) => c.id);

    const [update] = await tx
      .insert(updates)
      .values({
        tenantId: input.tenantId,
        repoId: input.repoId,
        title: input.draft.title,
        body: input.draft.body,
        category: input.draft.category,
        sourceItems: claimedIds,
      })
      .returning();

    await tx.update(changeItems).set({ updateId: update.id }).where(inArray(changeItems.id, claimedIds));

    return update;
  });
}
