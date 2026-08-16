"use client";

import { useEffect, useRef } from "react";

function autoGrow(el: HTMLTextAreaElement) {
  // Collapse first so the height can shrink when lines are removed, then fit.
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * The brief title, edited like a Notion page title — the same control as
 * `drafts/[releaseId]/draft-title-field.tsx`, with the dirty bookkeeping moved
 * out to `useBriefEditor`: this editor saves through a server function call
 * rather than a form submit, so one hook owns both fields' baselines instead
 * of each field owning its own.
 *
 * A textarea rather than an input so newlines are allowed.
 *
 * `autoFocus` defaults off: `/briefs/[briefId]` opens an *existing* brief, and
 * stealing focus onto the title there would be an unwanted jump on every
 * visit. `/briefs/new` (`NewBriefEditor`) opens onto a blank document with
 * nothing typed yet — the deleted field-by-field form had `autoFocus` on its
 * title input, and this is that behaviour's one legitimate caller.
 */
export function BriefTitleField({
  defaultValue,
  onChange,
  autoFocus = false,
}: {
  defaultValue: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Size to the stored title on mount (the server renders it at rows=1).
  useEffect(() => {
    if (ref.current) autoGrow(ref.current);
  }, []);

  return (
    <textarea
      ref={ref}
      id="brief-title"
      name="title"
      rows={1}
      defaultValue={defaultValue}
      placeholder="Untitled brief"
      aria-label="Title"
      autoFocus={autoFocus}
      onInput={(e) => {
        autoGrow(e.currentTarget);
        onChange(e.currentTarget.value);
      }}
      className="w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-4xl font-bold leading-tight tracking-tight outline-none placeholder:text-muted-foreground/40 focus:outline-none focus-visible:outline-none"
    />
  );
}
