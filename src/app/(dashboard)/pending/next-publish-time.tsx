"use client";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Shows the relative "in 5 days and 1 hour" label with the exact timestamp in a
 * tooltip (500ms hover delay). Both strings are computed server-side and passed
 * in, so there's no hydration mismatch from a client-side clock.
 */
export function NextPublishTime({ relative, absolute }: { relative: string; absolute: string }) {
  return (
    <TooltipProvider delay={500}>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="cursor-default font-medium text-foreground underline decoration-dotted underline-offset-2" />
          }
        >
          {relative}
        </TooltipTrigger>
        <TooltipContent>{absolute}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
