"use client";

import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AiVisibilityPayload } from "@/lib/ai-visibility/types";

/**
 * An `ai_visibility` chip in a brief's evidence row. Unlike the other kinds
 * — whose evidence is a link to the thing itself — an engine's answer has no
 * URL to point at, so the evidence has to be shown here or nowhere.
 *
 * Read-only, and short: this is the "why does the brief say that" glance,
 * not the record. The record is the dialog on /signals and the prompt
 * detail page.
 *
 * Its own `"use client"` module so `BriefEvidence` stays a Server Component:
 * a Popover is client-side, and one chip is not worth shipping the whole
 * evidence row to the browser.
 */
export function AiVisibilityEvidenceChip({
  title,
  payload,
}: {
  title: string;
  payload: AiVisibilityPayload;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button type="button" className="max-w-64">
            <Badge variant="outline" className="max-w-64">
              <span className="truncate" title={title}>
                {title}
              </span>
              <span className="text-muted-foreground">· AI visibility</span>
            </Badge>
          </button>
        }
      />
      <PopoverContent className="max-w-80 space-y-2">
        {payload.promptText && (
          <p className="text-xs text-muted-foreground">
            {payload.promptText}
            {payload.engineLabel ? ` · ${payload.engineLabel}` : ""} · {payload.samples}
          </p>
        )}
        {payload.excerpt && <p className="text-sm">{payload.excerpt}</p>}
        {payload.citedUrls && payload.citedUrls.length > 0 && (
          <ul className="flex flex-wrap gap-1">
            {payload.citedUrls.map((citation, index) => (
              <li key={`${citation.url}-${index}`}>
                <Badge variant="outline">{citation.domain}</Badge>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
