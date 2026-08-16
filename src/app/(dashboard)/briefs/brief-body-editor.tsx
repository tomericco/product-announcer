"use client";

import dynamic from "next/dynamic";

// `ssr: false`, exactly as `drafts/[releaseId]/draft-body-editor.tsx` does it:
// MDXEditor is a large client-only bundle and must not be part of this page's
// server render.
const MdxEditor = dynamic(() => import("./brief-mdx-editor"), { ssr: false });

/**
 * The brief body. Presentational: `useBriefEditor` owns the value, the
 * baseline and the dirty flag, including the initial-normalize case that the
 * second `onChange` argument reports.
 */
export function BriefBodyEditor({
  defaultValue,
  onChange,
}: {
  defaultValue: string;
  onChange: (markdown: string, initialMarkdownNormalize: boolean) => void;
}) {
  return (
    <div className="w-full">
      <MdxEditor markdown={defaultValue} onChange={onChange} />
    </div>
  );
}
