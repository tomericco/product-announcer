"use client";

import SharedMdxEditor from "@/components/markdown/mdx-editor";
import { ViewModeBridge } from "@/components/markdown/view-mode-bridge";

/**
 * The brief editor's MDXEditor, verbatim from `@/components/markdown/mdx-editor`
 * (which takes `{ markdown, onChange }` and nothing draft-specific) plus the
 * shared `ViewModeBridge` so the page's Source toggle can drive it.
 *
 * Its own module — rather than the shared editor imported directly by
 * `brief-body-editor` — because `ViewModeBridge` imports `@mdxeditor/editor` as
 * a runtime value: importing it at the top of `brief-body-editor` would pull
 * the whole editor into that chunk and defeat the `ssr: false` dynamic import
 * that keeps it out. Same arrangement as
 * `drafts/[releaseId]/mdx-editor.tsx`, which additionally wires the Ask AI /
 * extract bridges the brief editor has no equivalent of.
 */
export default function BriefMdxEditor({
  markdown,
  onChange,
}: {
  markdown: string;
  onChange: (md: string, initialMarkdownNormalize: boolean) => void;
}) {
  return (
    <SharedMdxEditor
      markdown={markdown}
      onChange={onChange}
      placeholder={<span className="text-muted-foreground/40">What should this piece say?</span>}
      parseErrorHint="Switch to Source mode (the Source button in the header) to view and edit the raw Markdown safely."
      realmChildren={<ViewModeBridge />}
    />
  );
}
