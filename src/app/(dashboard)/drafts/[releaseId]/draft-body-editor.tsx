"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useUnsavedChanges } from "../../unsaved-changes";

const MdxEditor = dynamic(() => import("./mdx-editor"), { ssr: false });

export function DraftBodyEditor({ defaultValue, contentPieceId }: { defaultValue: string; contentPieceId: string }) {
  const [body, setBody] = useState(defaultValue);
  const { setSectionDirty, cleanToken } = useUnsavedChanges();
  // What the body should compare against, and the newest value to compare.
  const baseline = useRef(defaultValue);
  const latest = useRef(defaultValue);

  // Re-baseline once edits are committed, so a later revert is measured against
  // what was saved rather than what was originally loaded.
  useEffect(() => {
    baseline.current = latest.current;
  }, [cleanToken]);

  // Clear this field's flag when the page unmounts, so navigating away can't
  // leave a stale warning armed on another page.
  useEffect(() => () => setSectionDirty("body", false), [setSectionDirty]);

  return (
    <div className="w-full">
      <input type="hidden" name="body" value={body} />
      <MdxEditor
        markdown={body}
        contentPieceId={contentPieceId}
        onChange={(md, initialMarkdownNormalize) => {
          setBody(md);
          latest.current = md;

          // On mount the editor rewrites the stored markdown into its own
          // dialect (bullet characters, escaping, whitespace). That isn't a user
          // edit — it's the resting state — so it becomes the baseline instead
          // of counting as a change. Comparing against the raw stored value
          // would leave every draft permanently dirty the moment it loaded.
          if (initialMarkdownNormalize) {
            baseline.current = md;
            setSectionDirty("body", false);
            return;
          }

          setSectionDirty("body", md !== baseline.current);
        }}
      />
    </div>
  );
}
