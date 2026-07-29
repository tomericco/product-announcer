"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useUnsavedChanges } from "../unsaved-changes";
import { GUIDELINES_TEMPLATE } from "@/lib/workspace/guidelines-template";

const MdxEditor = dynamic(() => import("@/components/markdown/mdx-editor"), { ssr: false });

export function GuidelinesEditor({ defaultValue }: { defaultValue: string | null }) {
  // A workspace with nothing stored edits the template rather than a blank
  // page. Nothing is written until they save, so the column stays null and the
  // prompt builders can still tell "never configured" from "configured".
  const initial = defaultValue ?? GUIDELINES_TEMPLATE;
  const [guidelines, setGuidelines] = useState(initial);
  const { setSectionDirty, cleanToken } = useUnsavedChanges();
  const baseline = useRef(initial);
  const latest = useRef(initial);

  // Re-baseline once edits are committed, so a later revert is measured against
  // what was saved rather than what was originally loaded.
  useEffect(() => {
    baseline.current = latest.current;
  }, [cleanToken]);

  // Clear this field's flag when the page unmounts, so navigating away can't
  // leave a stale warning armed on another page.
  useEffect(() => () => setSectionDirty("guidelines", false), [setSectionDirty]);

  return (
    <div className="w-full">
      <input type="hidden" name="guidelines" value={guidelines} />
      <MdxEditor
        markdown={guidelines}
        contentEditableClassName="mdx-content min-h-[50vh]"
        placeholder={<span className="text-muted-foreground/40">Brand guidelines</span>}
        onChange={(md, initialMarkdownNormalize) => {
          setGuidelines(md);
          latest.current = md;

          // On mount the editor rewrites the stored markdown into its own
          // dialect (bullet characters, escaping, whitespace). That isn't a user
          // edit — it's the resting state — so it becomes the baseline instead
          // of counting as a change.
          if (initialMarkdownNormalize) {
            baseline.current = md;
            setSectionDirty("guidelines", false);
            return;
          }

          setSectionDirty("guidelines", md !== baseline.current);
        }}
      />
    </div>
  );
}
