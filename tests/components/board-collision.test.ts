import { describe, it, expect } from "vitest";
import type { ClientRect } from "@dnd-kit/core";
import { boardCollisionDetection } from "../../src/app/(dashboard)/board/collision";

/**
 * The board's collision strategy, against the real `@dnd-kit/core` — nothing
 * mocked here at all. This is the half of the refusal rule that `disabled`
 * does not provide: dnd-kit takes the first collision the strategy returns
 * from among the ENABLED droppables, with no requirement that the winner be
 * anywhere near the pointer, so if the strategy always produces a winner
 * then so does the board.
 *
 * It lives apart from board-briefs.test.tsx because that file must stub
 * `DndContext` and the hooks (jsdom measures every element as 0×0). The
 * strategy itself is a pure function of rectangles and needs no such help.
 */

const W = 200;
const H = 600;
const rect = (index: number): ClientRect => ({
  top: 0,
  bottom: H,
  height: H,
  left: index * W,
  right: (index + 1) * W,
  width: W,
});

const COLUMNS = ["briefs", "brief", "draft", "review", "scheduled", "published"] as const;
const RECTS = new Map<string, ClientRect>(COLUMNS.map((id, i) => [id, rect(i)]));

const centerOf = (id: (typeof COLUMNS)[number]) => {
  const r = RECTS.get(id) as ClientRect;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

/** A dragged card, 180×80, centred on a point. */
const cardAt = (point: { x: number; y: number }): ClientRect => ({
  top: point.y - 40,
  bottom: point.y + 40,
  height: 80,
  left: point.x - 90,
  right: point.x + 90,
  width: 180,
});

function resolve({
  enabled,
  pointer,
  collisionRect,
}: {
  enabled: readonly string[];
  pointer: { x: number; y: number } | null;
  collisionRect: ClientRect;
}): string | null {
  const collisions = boardCollisionDetection({
    active: {
      id: "card",
      data: { current: undefined },
      rect: { current: { initial: collisionRect, translated: collisionRect } },
    },
    collisionRect,
    droppableRects: RECTS,
    // Exactly what DndContext passes: `droppableContainers.getEnabled()`.
    droppableContainers: enabled.map((id) => ({
      id,
      rect: { current: RECTS.get(id) },
      disabled: false,
    })),
    pointerCoordinates: pointer,
  } as never);
  return collisions.length > 0 ? String(collisions[0].id) : null;
}

describe("the board's collision strategy, on a pointer drag", () => {
  // The Critical, as a property: during a brief drag every column except
  // Generating is disabled, so a strategy that ranks candidates rather than
  // hit-testing them resolves EVERY release to Generating — which accepted
  // the brief, created a content piece and fired a generation.
  it.each(["briefs", "draft", "review", "scheduled", "published"] as const)(
    "resolves to nothing when a brief is released over %s with only Generating enabled",
    (releasedOver) => {
      const pointer = centerOf(releasedOver);

      expect(resolve({ enabled: ["brief"], pointer, collisionRect: cardAt(pointer) })).toBeNull();
    }
  );

  it("resolves to Generating when the brief is actually released over it", () => {
    const pointer = centerOf("brief");

    expect(resolve({ enabled: ["brief"], pointer, collisionRect: cardAt(pointer) })).toBe("brief");
  });

  // The same defect for content pieces, which predates briefs: a `draft`
  // piece released over Published used to land in whichever of Review and
  // Scheduled was nearer. Reversible, and so tolerated — but the identical
  // mechanism.
  it("resolves to nothing when a draft piece is released over Published", () => {
    const pointer = centerOf("published");

    expect(
      resolve({ enabled: ["review", "scheduled"], pointer, collisionRect: cardAt(pointer) })
    ).toBeNull();
  });

  it("still resolves an ordinary permitted move", () => {
    const pointer = centerOf("review");

    expect(
      resolve({ enabled: ["review", "scheduled"], pointer, collisionRect: cardAt(pointer) })
    ).toBe("review");
  });

  // Why the keyboard fallback below is branched on `pointerCoordinates`
  // rather than chained after an empty `pointerWithin`: here the card
  // straddles the Draft/Review boundary, so its RECT overlaps Review — but
  // the pointer is a pixel inside Draft, which is disabled. Judging a
  // pointer drag by the pointer refuses it; a rect fallback would not.
  it("resolves to nothing when the pointer is over a disabled column the card merely overlaps", () => {
    const boundary = RECTS.get("review")!.left;

    expect(
      resolve({
        enabled: ["review", "scheduled"],
        pointer: { x: boundary - 1, y: H / 2 },
        collisionRect: cardAt({ x: boundary, y: H / 2 }),
      })
    ).toBeNull();
  });
});

describe("the board's collision strategy, on a keyboard drag", () => {
  // `pointerCoordinates` is null for a KeyboardSensor drag: it comes from
  // `getEventCoordinates(activatorEvent)`, and a KeyboardEvent has no
  // clientX/clientY. `pointerWithin` returns [] outright in that case, so a
  // pointer-only strategy would make keyboard dragging impossible. The
  // board registers a KeyboardSensor, hence the rect fallback.
  it("falls back to rect overlap so a keyboard drag can still land", () => {
    expect(
      resolve({ enabled: ["review", "scheduled"], pointer: null, collisionRect: cardAt(centerOf("review")) })
    ).toBe("review");
  });

  it("still refuses a keyboard drag that overlaps no enabled column", () => {
    expect(
      resolve({ enabled: ["brief"], pointer: null, collisionRect: cardAt(centerOf("published")) })
    ).toBeNull();
  });
});
