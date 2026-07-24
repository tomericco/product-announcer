"use client";

import { cn } from "@/lib/utils";

/**
 * A row/card selection checkbox that stays out of the layout until its
 * `group`-marked ancestor is hovered (or the box is checked), then fades and
 * slides in. Collapse is done with `w-0` + a negative margin (not `hidden`) so
 * the appearance can transition; the negative margin cancels the parent flex
 * `gap` while collapsed so the following content sits flush. Pass
 * `collapsedMarginClass` matching the parent's gap — `-mr-2` for `gap-2`,
 * `-mr-3` for `gap-3`. Stays visible while `checked` so an active selection
 * never disappears when the pointer leaves.
 */
export function SelectionCheckbox({
  checked,
  onCheckedChange,
  label,
  collapsedMarginClass,
  forceVisible = false,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  collapsedMarginClass: string;
  /**
   * Keep the box shown regardless of hover/checked — set once any row in the
   * list is selected, so the whole list reveals its checkboxes together.
   */
  forceVisible?: boolean;
}) {
  return (
    <input
      type="checkbox"
      className={cn(
        "h-3.5 w-0 shrink-0 overflow-hidden rounded border-input opacity-0 transition-all duration-150",
        collapsedMarginClass,
        // Reveal on hover of the ancestor `group`, and on keyboard focus of the
        // box itself (it's focusable — collapsed via width/opacity, not
        // `hidden`) so tabbing to it isn't invisible.
        "group-hover:mr-0 group-hover:w-3.5 group-hover:opacity-100",
        "focus-visible:mr-0 focus-visible:w-3.5 focus-visible:opacity-100",
        (checked || forceVisible) && "mr-0 w-3.5 opacity-100"
      )}
      aria-label={label}
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  );
}
