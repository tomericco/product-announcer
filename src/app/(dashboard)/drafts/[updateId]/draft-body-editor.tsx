"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { useUnsavedChanges } from "../../unsaved-changes";

const MdxEditor = dynamic(() => import("./mdx-editor"), { ssr: false });

export function DraftBodyEditor({ defaultValue }: { defaultValue: string }) {
  const [body, setBody] = useState(defaultValue);
  const { markDirty } = useUnsavedChanges();

  return (
    <div className="w-full">
      <input type="hidden" name="body" value={body} />
      <MdxEditor
        markdown={body}
        onChange={(md, initialMarkdownNormalize) => {
          setBody(md);
          // The editor fires onChange once on mount while it normalizes the
          // stored markdown. That isn't a user edit, so it must not arm the
          // unsaved-changes warning on a draft nobody has touched.
          if (!initialMarkdownNormalize) markDirty();
        }}
      />
    </div>
  );
}
