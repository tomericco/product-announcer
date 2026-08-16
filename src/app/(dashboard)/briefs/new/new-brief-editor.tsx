"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SourceToggleButton } from "@/components/markdown/editor-context";
import {
  BRIEF_TEMPLATE,
  EMPTY_BRIEF_BODY_ERROR,
  UNFILLED_BRIEF_TEMPLATE_ERROR,
  isBlankBriefBody,
  isUnfilledBriefTemplate,
} from "@/lib/briefs/body";
import type { Brief } from "@/db/schema";
import type { CitedSignal } from "@/lib/briefs/query";
import { GuardedLink, useUnsavedChanges } from "../../unsaved-changes";
import { BriefBodyEditor } from "../[briefId]/brief-body-editor";
import { BriefEvidence } from "../[briefId]/brief-evidence";
import { BriefTitleField } from "../[briefId]/brief-title-field";
import { createManualBrief, type ManualBriefInput } from "./actions";

/**
 * Spelled out rather than read off `contentTypeEnum`, which is a runtime value
 * in `@/db/schema` and would pull drizzle's pg-core into this client bundle for
 * three strings. `Record<Brief["contentType"], string>` over a type-only import
 * is what keeps it honest: a fourth content type added to the enum makes this
 * map a compile error, so no value can go quietly unofferable here.
 */
const CONTENT_TYPE_LABEL: Record<Brief["contentType"], string> = {
  product_update: "Product update",
  blog_post: "Blog post",
  social_post: "Social post",
};

const CONTENT_TYPES = Object.keys(CONTENT_TYPE_LABEL) as Brief["contentType"][];

/**
 * A manual brief's score. 0.5 is a neutral placeholder, not a judgement — the
 * design doc is explicit that a manual brief's score "means less here" and it
 * is never surfaced back to the human as an assessment of their own idea. Kept
 * verbatim from the field-by-field form this page replaced, along with the
 * empty `suggestedChannel` and `scoreRationale` that went with it.
 */
const MANUAL_BRIEF_SCORE = 0.5;

/**
 * `/briefs/new`: a brief written by hand, in the same editor a proposed brief
 * is edited in. `MdxEditor`, the `editor-context` bridge behind the Source
 * toggle, the title field, the evidence row — every one of them is the
 * component `/briefs/[briefId]` uses, imported rather than restated, because
 * the point of this page is that the two surfaces ARE the same editor.
 *
 * What it does not share is the save. `/briefs/[briefId]` edits a row that
 * already exists and commits with `saveBriefBody`; here **nothing is written
 * until Create is pressed** — abandoning this page leaves no row at all, which
 * is the reason it stayed a page rather than becoming a create-then-redirect
 * action like the proposal modal. So the dirty bookkeeping below mirrors
 * `useBriefEditor`'s (same baselines, same initial-normalize rule) but arms the
 * leave guard rather than gating a Save button: with nothing saved, walking
 * away is the only way to lose work.
 *
 * Content type is a control here and a read-only badge on `/briefs/[briefId]`,
 * deliberately: `generateDraftForPiece` forks on `contentType ===
 * "product_update"` into the release composition, so a hand-written product
 * update filed under the wrong type drafts down the wrong branch — and this is
 * the only moment a human can set it, because nothing about it can be inferred
 * from the prose.
 *
 * `evidence` is fixed, not editable here: the signals came from `/signals` (via
 * `?signals=`, the proposal modal's failure fallback) and the page resolved
 * them tenant-scoped. `createManualBrief` re-reads the ids under the caller's
 * own tenant anyway, so nothing here is trusted as a permission.
 *
 * `children` is the page's server-rendered over-cap notice, passed through in
 * the same place `BriefWorkspace` takes its badge row.
 */
export function NewBriefEditor({
  evidence,
  children,
}: {
  evidence: CitedSignal[];
  children?: ReactNode;
}) {
  const router = useRouter();
  const { setSectionDirty } = useUnsavedChanges();

  const [contentType, setContentType] = useState<Brief["contentType"]>("blog_post");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState(BRIEF_TEMPLATE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What each field compares against. The body's moves once, on the editor's
  // initial normalize; the title's never moves, because "" is the only value
  // an untouched title ever had.
  const bodyBaseline = useRef(BRIEF_TEMPLATE);

  const onTitleChange = useCallback(
    (value: string) => {
      setTitle(value);
      setSectionDirty("new-brief-title", value.length > 0);
    },
    [setSectionDirty]
  );

  const onBodyChange = useCallback(
    (markdown: string, initialMarkdownNormalize: boolean) => {
      setBody(markdown);

      // On mount the editor rewrites the seeded template into its own dialect
      // (bullet characters, escaping, whitespace). That isn't a user edit —
      // it's the resting state — so it becomes the baseline rather than arming
      // the leave guard on a page nobody has typed into. Same rule, and same
      // reason, as `useBriefEditor`.
      if (initialMarkdownNormalize) {
        bodyBaseline.current = markdown;
        setSectionDirty("new-brief-body", false);
        return;
      }

      setSectionDirty("new-brief-body", markdown !== bodyBaseline.current);
    },
    [setSectionDirty]
  );

  // Clear both flags when the page unmounts, so navigating away can't leave a
  // stale warning armed on another page.
  useEffect(
    () => () => {
      setSectionDirty("new-brief-title", false);
      setSectionDirty("new-brief-body", false);
    },
    [setSectionDirty]
  );

  function leaveWithoutSaving() {
    // Cancel is a decision to discard, so it disarms the guard rather than
    // tripping it — the unmount effect above would do this a moment later
    // anyway, but not before `router.push` has already been asked for.
    setSectionDirty("new-brief-title", false);
    setSectionDirty("new-brief-body", false);
    router.push("/board");
  }

  async function onCreate() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;

    // Refused here rather than at the server's blank guard, which cannot see
    // it: a template is not blank, it is four headings and a bullet, and
    // `isBlankBriefBody` would wave it through into a commission the model has
    // nothing to write from. The blank case still exists (someone can delete
    // the template outright) and gets the blank message, from the same module
    // the server's guard uses so the two read identically.
    if (isUnfilledBriefTemplate(body)) {
      setError(isBlankBriefBody(body) ? EMPTY_BRIEF_BODY_ERROR : UNFILLED_BRIEF_TEMPLATE_ERROR);
      return;
    }

    setSubmitting(true);
    setError(null);

    const input: ManualBriefInput = {
      contentType,
      title: trimmedTitle,
      // The document, written directly. `createManualBrief` stores an explicit
      // body verbatim instead of rendering one from the fields below.
      body,
      // The NOT NULL columns this page does not collect. A body-first brief has
      // no separate angle/why-now/key-points/audience — the prose IS those
      // sections — and empty strings are what satisfies the constraint.
      //
      // That is safe ONLY because `body` is set: `briefBody`'s fallback (which
      // would render these empty fields into an empty document) fires only for
      // a null body, and this path never writes one. Do not "fix" these by
      // parsing the markdown back into fields — that would recreate the second
      // body writer this branch has twice had to delete.
      angle: "",
      whyNow: "",
      keyPoints: [],
      audience: null,
      suggestedChannel: "",
      targetLength: null,
      score: MANUAL_BRIEF_SCORE,
      // The model's own rationale for `score`, which there is no model to have
      // produced here.
      scoreRationale: null,
      signalIds: evidence.map((signal) => signal.id),
      // `expiresAt` is deliberately omitted: a brief someone typed is a
      // decision, and the sweep must not expire it out from under them.
    };

    const result = await createManualBrief(input);
    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setSectionDirty("new-brief-title", false);
    setSectionDirty("new-brief-body", false);
    router.push("/board");
  }

  return (
    <>
      <div className="sticky top-0 z-20 -mx-4 flex items-center justify-between gap-3 bg-background px-4 py-3">
        <GuardedLink
          href="/board"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Board
        </GuardedLink>
        <SourceToggleButton />
      </div>

      {children}

      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          {evidence.length > 0
            ? "Write it yourself — the signals you selected are attached as evidence."
            : "Write a brief by hand and it lands on the board's Brief column like any other."}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="brief-content-type" className="text-xs text-muted-foreground">
            Content type
          </Label>
          <Select
            value={contentType}
            onValueChange={(value) => setContentType(value as Brief["contentType"])}
          >
            <SelectTrigger id="brief-content-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTENT_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {CONTENT_TYPE_LABEL[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <BriefEvidence signals={evidence} />
      </div>

      {/* The visible title is a textarea, so the document outline would
          otherwise have no heading at all — give screen readers a real h1. */}
      <h1 className="sr-only">New brief</h1>
      <BriefTitleField defaultValue="" onChange={onTitleChange} />
      <BriefBodyEditor defaultValue={BRIEF_TEMPLATE} onChange={onBodyChange} />

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-3 pt-4">
        <Button variant="outline" onClick={leaveWithoutSaving} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={onCreate} disabled={submitting || !title.trim()}>
          {submitting ? "Creating…" : "Create brief"}
        </Button>
      </div>
    </>
  );
}
