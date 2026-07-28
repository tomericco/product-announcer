import { cn } from "@/lib/utils";
import {
  MARK_PATH,
  MARK_STROKE_WIDTH,
  MARK_TILE_FILL,
  MARK_TILE_RADIUS,
  MARK_TILE_SIZE,
} from "./mark-path";

/**
 * The versional mark: a handwritten "v" on a dark tile.
 *
 * The tile is not decoration. The accent is ~1.2:1 against white, so an
 * unbacked chartreuse glyph disappears on a light background. Sitting it on a
 * fixed dark tile is what lets the accent stay bright in both colour modes --
 * which is also why MARK_TILE_FILL is hardcoded rather than tied to
 * --foreground, which inverts.
 *
 * The glyph is an outlined path rather than live Caveat text so that it is
 * byte-identical to the favicon and does not flash a fallback face while the
 * webfont loads. See ./mark-path.ts.
 */
export function Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${MARK_TILE_SIZE} ${MARK_TILE_SIZE}`}
      fill="none"
      aria-hidden="true"
      className={cn("size-6 shrink-0", className)}
    >
      <rect
        width={MARK_TILE_SIZE}
        height={MARK_TILE_SIZE}
        rx={MARK_TILE_RADIUS}
        fill={MARK_TILE_FILL}
      />
      <path
        d={MARK_PATH}
        stroke="var(--brand)"
        strokeWidth={MARK_STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Mark plus wordmark. The wordmark is set in the script face. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <Mark />
      <span className="font-script text-3xl leading-none">versional</span>
    </span>
  );
}
