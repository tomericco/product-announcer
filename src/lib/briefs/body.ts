import type { Brief } from "@/db/schema";

// Deliberately NOT importing from "@/db" (the module that instantiates the pg
// Pool) — this file is imported from client components (the brief editor), and
// pulling in anything with a top-level `db` import drags `pg` into the client
// bundle. Type-only imports from "@/db/schema" are erased at compile time and
// don't have that problem; the schema module itself has no runtime `pg`
// dependency either.
//
// Plain field values, not the full `Brief` row — a `Pick<>` of exactly what
// rendering needs, so this module's surface can't accidentally grow a
// dependency on something read from the database.
export type BriefBodyFields = Pick<Brief, "angle" | "whyNow" | "keyPoints" | "audience">;

function section(heading: string, content: string | null | undefined): string | null {
  if (!content) return null;
  return `## ${heading}\n${content}`;
}

/**
 * Pure: structured brief fields in, markdown out. Called once at brief
 * creation to seed `briefs.body`, and again by `briefBody` below as the
 * fallback for rows created before that column existed — the same function
 * both times, which is what makes the missing backfill safe.
 *
 * The title is not a parameter: it is a separate field with its own control,
 * not a body section. A section whose field is null or empty (including an
 * empty `keyPoints` array) is omitted entirely rather than emitted with an
 * empty body — an empty "## Audience" heading reads as a mistake, not as an
 * absence.
 */
export function renderBriefBody(fields: BriefBodyFields): string {
  const sections = [
    section("Angle", fields.angle),
    section("Why now", fields.whyNow),
    fields.keyPoints.length > 0
      ? `## Key points\n${fields.keyPoints.map((point) => `- ${point}`).join("\n")}`
      : null,
    section("Audience", fields.audience),
  ].filter((value): value is string => value !== null);

  return sections.join("\n\n");
}

/**
 * The one accessor every read of a brief's document body goes through.
 * `brief.body` is the source of truth once a human (or the creation flow)
 * has written it; a null body — every brief created before this column
 * existed — renders from the structured fields on demand, byte-identical to
 * what `renderBriefBody` would have produced at creation. There is no
 * migration that backfills this column and there must not be one: the
 * fallback IS the renderer, so there is no second code path to drift.
 */
export function briefBody(brief: Pick<Brief, "body"> & BriefBodyFields): string {
  return brief.body ?? renderBriefBody(brief);
}
