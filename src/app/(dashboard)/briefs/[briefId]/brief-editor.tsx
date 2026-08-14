"use client";

import { Button } from "@/components/ui/button";
import { BriefTitleField } from "./brief-title-field";
import { BriefBodyEditor } from "./brief-body-editor";
import { useBriefEditor } from "./use-brief-editor";

/**
 * Title + body + Save, over `useBriefEditor` — which owns the baselines, the
 * dirty flags and the server call. Deliberately NOT a `<form>`: `saveBriefBody`
 * takes an object rather than FormData, so there is no submit event and the
 * hook re-baselines and calls `notifySaved()` itself.
 */
export function BriefEditor({
  briefId,
  initialTitle,
  initialBody,
}: {
  briefId: string;
  initialTitle: string;
  initialBody: string;
}) {
  const editor = useBriefEditor({ briefId, initialTitle, initialBody });

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
