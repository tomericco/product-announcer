import { pointerWithin, rectIntersection, type CollisionDetection } from "@dnd-kit/core";

/**
 * How the board decides which column a drop landed on.
 *
 * The obvious choice, `closestCenter`, is wrong here — dangerously so once
 * the Brief column exists. Two facts from `@dnd-kit/core` 6.3.1 combine:
 *
 *   1. `DndContext` passes only `droppableContainers.getEnabled()` to the
 *      strategy and then takes `getFirstCollision(collisions, "id")`
 *      **unconditionally**. There is no "the pointer must actually be over
 *      it" requirement anywhere in that path.
 *   2. `closestCenter` ranks *every* candidate by centre distance and
 *      returns them all, so it always produces a winner as long as one
 *      droppable is enabled.
 *
 * So `disabled` controls candidacy, not hit-testing. During a brief drag
 * the board disables all five piece columns and the Brief column itself,
 * leaving exactly one enabled droppable — and `closestCenter` then resolved
 * every release, anywhere on the board, to it. A 7px jitter on a brief card
 * (`PointerSensor` activates at 6px) accepted the brief: a content piece
 * created, the brief flipped to `accepted` with no un-accept path, and an
 * LLM generation fired. The same shape had always been true for content
 * pieces — releasing a `draft` over Published moved it to whichever of
 * Review/Scheduled was nearer — but that was reversible, which is why it
 * went unnoticed until acceptance made it expensive.
 *
 * `pointerWithin` is the fix: it returns only droppables whose rect
 * actually contains the pointer, so a release over a refused column, or
 * over nothing at all, yields no collision and `over` is `null`.
 *
 * The fallback is not decoration. `pointerWithin` returns `[]` outright
 * when `pointerCoordinates` is null, and `pointerCoordinates` is derived
 * from `getEventCoordinates(activatorEvent)`, which is null for a
 * `KeyboardEvent` — it has no `clientX`/`clientY`. This board registers a
 * `KeyboardSensor`, so a pointer-only strategy would make keyboard dragging
 * impossible rather than merely strict. `rectIntersection` covers that
 * case: it needs the dragged card's own rect to genuinely overlap a
 * column's, which keeps the same guarantee (no overlap, no drop) using the
 * only geometry a keyboard drag has.
 *
 * Branching on `pointerCoordinates` rather than the more common
 * `pointerWithin(args) || rectIntersection(args)` fallback is deliberate:
 * with the latter, a pointer drag that lands in the gutter *between*
 * columns would fall through to rect overlap and could still resolve onto a
 * column the pointer was never over. Here a pointer drag is judged by the
 * pointer, always.
 */
export const boardCollisionDetection: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args);
