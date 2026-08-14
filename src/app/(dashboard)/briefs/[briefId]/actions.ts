"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { briefs } from "@/db/schema";
import { EMPTY_BRIEF_BODY_ERROR, isBlankBriefBody } from "@/lib/briefs/body";
import { requireSession } from "@/lib/workspace/session";

// NOTHING but async functions may be exported from a "use server" module — no
// `const`, no type alias, not even a re-exported type. Both the result shape
// and the argument shape below are therefore written inline. This has broken
// the build twice; see the sibling `briefs/actions.ts` for the same rule.

/**
 * The brief editor's save. `saveDraft`'s counterpart for a brief, with three
 * differences that matter:
 *
 *   - It is called imperatively from the client with a plain object rather
 *     than through a `<form action>`, so it reports refusals as a result
 *     rather than throwing — the editor toasts them.
 *   - It stamps `briefs.editedAt`. Nothing wrote that column before this
 *     spec, which is what makes "has a human touched this brief?" answerable
 *     at all.
 *   - It refuses an `accepted` or `dismissed` brief. Those open read-only in
 *     the UI, but the UI is not the boundary: `briefId` arrives from a URL and
 *     a crafted request must not edit a brief whose draft has already been
 *     generated, silently diverging the two.
 *
 * `title` is optional so the documented `{ briefId, body }` call still works,
 * but the editor always sends it — the page renders an editable title field
 * (the spec's "a title field and save/dirty-state wiring mirroring
 * draft-title-field.tsx"), and a title field whose edits vanish on save would
 * be worse than no title field at all.
 */
export async function saveBriefBody({
  briefId,
  body,
  title,
}: {
  briefId: string;
  body: string;
  title?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;

  // Tenant scoping is the security boundary, not a convenience: the id comes
  // from the URL, and briefs carry a company's unpublished content strategy.
  // Returning the same "not found" for "does not exist" and "not yours" also
  // avoids confirming another tenant's brief exists.
  const [brief] = await db
    .select()
    .from(briefs)
    .where(and(eq(briefs.id, briefId), eq(briefs.tenantId, tenantId)));
  if (!brief) return { ok: false, error: "Brief not found." };

  if (brief.status === "accepted" || brief.status === "dismissed") {
    return { ok: false, error: `This brief was already ${brief.status} and can no longer be edited.` };
  }

  // An empty body is refused rather than stored, through the shared guard in
  // `@/lib/briefs/body` — `createManualBrief` is the other writer of this
  // column and calls the same one, because two writers with two opinions about
  // "" is precisely how this defect got in. Why "" is unrescuable is documented
  // there; the reason specific to THIS path is that a blank submission here is
  // usually not a human intention at all: when MDXEditor fails to parse the
  // stored markdown it renders blank and then emits "" on the next keystroke
  // (`resolveBody` in `drafts/actions.ts` exists for exactly that failure), and
  // accepting it would let a parse error erase a commission.
  if (isBlankBriefBody(body)) {
    return { ok: false, error: EMPTY_BRIEF_BODY_ERROR };
  }

  // `briefs.title` is NOT NULL and is copied onto the content piece at accept
  // time, so a blank one is refused for the same reason as a blank body.
  const nextTitle = title?.trim();
  if (title !== undefined && !nextTitle) {
    return { ok: false, error: "A brief needs a title." };
  }

  await db
    .update(briefs)
    .set({
      body,
      ...(nextTitle ? { title: nextTitle } : {}),
      editedAt: new Date(),
    })
    .where(and(eq(briefs.id, briefId), eq(briefs.tenantId, tenantId)));

  revalidatePath("/briefs");
  revalidatePath(`/briefs/${briefId}`);

  return { ok: true };
}
