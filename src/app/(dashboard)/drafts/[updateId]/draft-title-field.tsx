"use client";

import { useEffect, useRef } from "react";

function autoGrow(el: HTMLTextAreaElement) {
  // Collapse first so the height can shrink when lines are removed, then fit.
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * The draft title, edited like a Notion page title: no chrome, and it grows to
 * fit however many lines you type.
 *
 * A textarea rather than an input so newlines are allowed. Note the side effect:
 * in a textarea, Enter inserts a line break instead of submitting the form.
 */
export function DraftTitleField({ defaultValue }: { defaultValue: string }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Size to the stored title on mount (the server renders it at rows=1).
  useEffect(() => {
    if (ref.current) autoGrow(ref.current);
  }, []);

  return (
    <textarea
      ref={ref}
      id="title"
      name="title"
      rows={1}
      defaultValue={defaultValue}
      placeholder="Untitled"
      aria-label="Title"
      onInput={(e) => autoGrow(e.currentTarget)}
      className="w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-4xl font-bold leading-tight tracking-tight outline-none placeholder:text-muted-foreground/40 focus:outline-none focus-visible:outline-none"
    />
  );
}
