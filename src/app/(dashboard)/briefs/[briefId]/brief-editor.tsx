"use client";

import { Button } from "@/components/ui/button";
import { BriefTitleField } from "./brief-title-field";
import { BriefBodyEditor } from "./brief-body-editor";
import type { useBriefEditor } from "./use-brief-editor";

/**
 * Title + body + Save, over `useBriefEditor` — which owns the baselines, the
 * dirty flags and the server call. Deliberately NOT a `<form>`: `saveBriefBody`
 * takes an object rather than FormData, so there is no submit event and the
 * hook re-baselines and calls `notifySaved()` itself.
 *
 * The hook is passed in rather than called here: the header's Accept and
 * Dismiss must commit unsaved edits before they run, so one owner holds it for
 * both (see `brief-workspace.tsx`).
 */
export function BriefEditor({
  initialTitle,
  initialBody,
  editor,
}: {
  initialTitle: string;
  initialBody: string;
  editor: ReturnType<typeof useBriefEditor>;
}) {
  return (
    <div className="space-y-4">
      {/* The visible title is a textarea, so the document outline would
          otherwise have no heading at all — give screen readers a real h1. */}
      <h1 className="sr-only">{initialTitle || "Untitled brief"}</h1>
      <BriefTitleField defaultValue={initialTitle} onChange={editor.setTitle} />
      <BriefBodyEditor defaultValue={initialBody} onChange={editor.setBody} />
      <div className="flex items-center gap-3 pt-4">
        <Button onClick={editor.save} disabled={editor.saving || !editor.dirty}>
          {editor.saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
