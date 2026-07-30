import { cn } from "@/lib/utils";

/**
 * The green light shown in an integration card's header once that integration is
 * connected and healthy. It's the positive counterpart to the "Needs reconnect" /
 * "Setup incomplete" badges that sit in the same slot — a card renders one or the
 * other, never both, so the header always reads as a single status.
 *
 * The dot is paired with a text label on purpose: colour alone shouldn't be the
 * only carrier of the status.
 */
export function ConnectedIndicator({ label = "Connected", className }: { label?: string; className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-2 text-xs font-medium text-muted-foreground", className)}>
      <span aria-hidden className="size-2 rounded-full bg-emerald-500 ring-4 ring-emerald-500/20" />
      {label}
    </span>
  );
}
