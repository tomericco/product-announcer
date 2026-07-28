"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Explains, on hover, why the control it wraps is disabled.
 *
 * Two details carry this, and both are easy to drop:
 *
 * 1. The trigger is the surrounding span, not the control. A disabled <button>
 *    emits no pointer events, so a tooltip bound to the button never opens.
 * 2. `[&>*]:pointer-events-none` makes the hover actually reach that span. A
 *    disabled button doesn't merely ignore events — in several browsers it
 *    swallows them instead of letting them through to the parent, so without
 *    this the tooltip stays shut precisely when the cursor is over the button.
 *
 * The trigger renders as a span rather than its default <button> so we never
 * nest a button inside a button.
 *
 * Only wrap DISABLED controls: point 2 neutralizes clicks on whatever is inside.
 * Keep `hint` to one short sentence — the popup caps at max-w-xs, and a
 * paragraph in a tooltip is a paragraph nobody reads.
 */
export function DisabledHint({ hint, children }: { hint: string; children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex [&>*]:pointer-events-none" />}>
          {children}
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
