"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useUnsavedChanges } from "../../unsaved-changes";
import { saveBriefBody } from "./actions";

/**
 * The brief editor's dirty-state and save wiring, in a hook so it can be
 * exercised with `renderHook` rather than only through the rendered editor —
 * the body editor itself is behind a `ssr: false` dynamic import of MDXEditor
 * and is not worth mounting in jsdom, but this is where the bugs live. Three
 * bugs on this branch lived in untested effect wiring.
 *
 * It mirrors `draft-title-field.tsx` and `draft-body-editor.tsx` rather than
 * inventing a second pattern: a per-field baseline that starts at the stored
 * value and moves to whatever was last committed, so reverting an edit clears
 * the warning and a revert AFTER a save is still measured against the save.
 * The one thing it does differently is holding both baselines in one place —
 * the drafts editor commits through a `<form action={saveDraft}>` and lets the
 * provider's submit listener re-baseline both fields, and there is no form
 * here to listen for.
 */
export function useBriefEditor({
  briefId,
  initialTitle,
  initialBody,
}: {
  briefId: string;
  initialTitle: string;
  initialBody: string;
}) {
  const [title, setTitleState] = useState(initialTitle);
  const [body, setBodyState] = useState(initialBody);
  const [titleDirty, setTitleDirty] = useState(false);
  const [bodyDirty, setBodyDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const { setSectionDirty, notifySaved } = useUnsavedChanges();

  // What each field compares against, and the newest value of each. `latest`
  // is what makes a save that lands while the user keeps typing re-baseline
  // against what was actually sent, not against whatever is on screen now.
  const titleBaseline = useRef(initialTitle);
  const bodyBaseline = useRef(initialBody);
  const latestTitle = useRef(initialTitle);
  const latestBody = useRef(initialBody);

  const setTitle = useCallback(
    (value: string) => {
      setTitleState(value);
      latestTitle.current = value;
      const dirty = value !== titleBaseline.current;
      setTitleDirty(dirty);
      setSectionDirty("brief-title", dirty);
    },
    [setSectionDirty]
  );

  const setBody = useCallback(
    (markdown: string, initialMarkdownNormalize: boolean) => {
      setBodyState(markdown);
      latestBody.current = markdown;

      // On mount the editor rewrites the stored markdown into its own dialect
      // (bullet characters, escaping, whitespace). That isn't a user edit —
      // it's the resting state — so it becomes the baseline instead of
      // counting as a change. Comparing against the raw stored value would
      // leave every brief permanently dirty the moment it loaded.
      if (initialMarkdownNormalize) {
        bodyBaseline.current = markdown;
        setBodyDirty(false);
        setSectionDirty("brief-body", false);
        return;
      }

      const dirty = markdown !== bodyBaseline.current;
      setBodyDirty(dirty);
      setSectionDirty("brief-body", dirty);
    },
    [setSectionDirty]
  );

  // Clear both flags when the page unmounts, so navigating away can't leave a
  // stale warning armed on another page.
  useEffect(
    () => () => {
      setSectionDirty("brief-title", false);
      setSectionDirty("brief-body", false);
    },
    [setSectionDirty]
  );

  const save = useCallback(async () => {
    // The values actually sent to the server. Re-read from the refs rather
    // than closing over the rendered state, so a save fired from a stale
    // render still sends what the user last typed.
    const sentTitle = latestTitle.current;
    const sentBody = latestBody.current;

    setSaving(true);
    try {
      const result = await saveBriefBody({ briefId, title: sentTitle, body: sentBody });
      if (!result.ok) {
        toast.error(result.error);
        return result;
      }

      titleBaseline.current = sentTitle;
      bodyBaseline.current = sentBody;
      // Not unconditionally false: the user may have kept typing while the
      // round trip was in flight, and those keystrokes are genuinely unsaved.
      const stillDirtyTitle = latestTitle.current !== sentTitle;
      const stillDirtyBody = latestBody.current !== sentBody;
      setTitleDirty(stillDirtyTitle);
      setBodyDirty(stillDirtyBody);
      // Clears every section and bumps the provider's cleanToken. Called
      // BEFORE re-arming, because it resets the whole map.
      notifySaved();
      setSectionDirty("brief-title", stillDirtyTitle);
      setSectionDirty("brief-body", stillDirtyBody);
      toast.success("Changes saved");
      return result;
    } finally {
      setSaving(false);
    }
  }, [briefId, notifySaved, setSectionDirty]);

  const dirty = titleDirty || bodyDirty;

  /**
   * Commit whatever is unsaved, and report whether it is now safe to do
   * something that leaves this editor behind. Returns true when there was
   * nothing to save (so an untouched brief is never stamped with a spurious
   * `editedAt`) and when a save landed; false when the server refused, in
   * which case the caller must NOT proceed — the refusal has already been
   * toasted.
   *
   * This exists because Accept navigates away with `router.push`, which is not
   * a `GuardedLink` and therefore never reaches `requestLeave`. Without it,
   * "open, edit, Accept" — the natural flow on this page — hands the model the
   * PRE-edit commission and then flips the brief to `accepted`, which both
   * this page and `saveBriefBody` treat as read-only. The edits are gone, and
   * nothing anywhere says so.
   */
  const saveIfDirty = useCallback(async () => {
    if (!dirty) return true;
    const result = await save();
    return result.ok;
  }, [dirty, save]);

  return {
    title,
    body,
    setTitle,
    setBody,
    save,
    saveIfDirty,
    saving,
    dirty,
  };
}
