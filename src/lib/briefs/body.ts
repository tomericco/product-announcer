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

/**
 * THE guard every writer of `briefs.body` shares. It lives here, next to the
 * accessor it protects, because there is more than one writer and they must not
 * disagree: `saveBriefBody` (the editor's save) and `createManualBrief` (the
 * new-brief form, where `renderBriefBody` can return "" because every field it
 * renders is optional and only `title` is validated).
 *
 * "" is the one value the null fallback cannot rescue. It is not null, so
 * `briefBody` returns it unchanged; `composeBriefPrompt`'s `.filter(Boolean)`
 * then drops it, and the model receives a commission with a title and format
 * guidance and no prose at all — silently, with nothing anywhere reporting a
 * problem.
 *
 * The alternative — teaching `briefBody` to treat "" as null — is worse. On the
 * edit path it would silently resurrect the structured fields a human had just
 * deleted; on the create path it would fall back to a renderer that produces ""
 * for exactly these inputs anyway, so it fixes nothing. Refusing at the writer
 * is the only place the human can still be told.
 */
export function isBlankBriefBody(body: string): boolean {
  return body.trim().length === 0;
}

/** The message both writers report when {@link isBlankBriefBody} refuses. */
export const EMPTY_BRIEF_BODY_ERROR =
  "A brief needs a body — it is the commission the draft is written from.";

/**
 * The skeleton a hand-written brief starts from: exactly the headings
 * {@link renderBriefBody} emits, in the same order, so a hand-written brief
 * and a proposed one are indistinguishable downstream — `briefBody`'s
 * fallback semantics stay coherent whichever way a brief's body arrived.
 *
 * Kept beside `renderBriefBody` rather than inlined in the `/briefs/new`
 * page: if the renderer's headings ever change, this must move with them,
 * and colocation is what makes that obvious. See `body.test.ts`, which
 * derives its expected headings from `renderBriefBody`'s own output rather
 * than a second hardcoded copy, so the two cannot silently drift apart.
 */
export const BRIEF_TEMPLATE = `## Angle



## Why now



## Key points

-

## Audience

`;

/** {@link BRIEF_TEMPLATE}'s own heading lines, derived rather than restated. */
const BRIEF_TEMPLATE_HEADINGS = BRIEF_TEMPLATE.split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith("#"));

/**
 * True when `body` carries nothing but {@link BRIEF_TEMPLATE}'s skeleton — the
 * headings and the empty bullet, with no prose under any of them. A brief whose
 * body is only empty headings is not a brief: it reaches the model as a
 * commission with a title and four section names and nothing to write from,
 * which is the same failure {@link isBlankBriefBody} exists to prevent, one
 * step less obvious.
 *
 * NOT the same guard, and deliberately not folded into it. `isBlankBriefBody`
 * is what every writer of `briefs.body` shares, including the editor's save on
 * an existing brief — a human who deletes a section heading there has done
 * something meaningful and must not be refused. This one is about a specific
 * moment: the `/briefs/new` page pressing Create on a template nobody typed
 * into. It is applied there, on the client, before the round trip.
 *
 * The headings are read off `BRIEF_TEMPLATE` at module load, so renaming a
 * section in the template renames it here too and this cannot drift from the
 * skeleton it is describing.
 *
 * A blank body satisfies this as well (nothing is left after stripping
 * nothing), so a caller that wants to distinguish "you didn't fill the template
 * in" from "there is no body at all" must test {@link isBlankBriefBody} first.
 */
export function isUnfilledBriefTemplate(body: string): boolean {
  return (
    body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      // The template's own headings say nothing on their own.
      .filter((line) => !BRIEF_TEMPLATE_HEADINGS.includes(line))
      // The empty bullet under "Key points", in whichever marker the editor
      // normalized it to — MDXEditor rewrites the stored markdown into its own
      // dialect on mount, and `-` coming back as `*`, or backslash-escaped
      // because it has nothing after it, is not the human typing.
      //
      // Deliberately generous: the cost of a marker this misses is that an
      // untouched template gets created as a brief (annoying, and the human
      // can see and fix it), while the cost of matching too much would be
      // refusing a brief someone actually wrote. Erring toward creating is the
      // right way round.
      .filter((line) => !/^\\?[-*+]\s*$/.test(line)).length === 0
  );
}

/** The message `/briefs/new` shows when {@link isUnfilledBriefTemplate} refuses. */
export const UNFILLED_BRIEF_TEMPLATE_ERROR =
  "Fill the template in — a body of empty headings isn't a commission yet.";
