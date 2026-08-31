"use client";

import { Button } from "@/components/ui/button";
import { useGenerationLock } from "./generation-lock";

/**
 * A card's Save button, disabled while that card's Generate band is running.
 *
 * The editor being read-only is not enough on its own. Save posts whatever the
 * editor held BEFORE the generation started, and if that write lands after the
 * derivation's it silently replaces the freshly generated value with the text
 * the generation was meant to replace. Locking both ends of the card removes
 * the race rather than making it unlikely.
 */
export function SaveButton({ children = "Save" }: { children?: React.ReactNode }) {
  const { generating } = useGenerationLock();
  return (
    <Button type="submit" variant="outline" disabled={generating}>
      {children}
    </Button>
  );
}
