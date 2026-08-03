import { gte, type SQL } from "drizzle-orm";
import { signals } from "@/db/schema";

/**
 * How far back signals are considered. Enforced on READ — nothing deletes from
 * the table yet, deliberately: the irreversible half of retention waits until
 * the shape of the data is known.
 *
 * When deletion is built it MUST use this same constant and the same column
 * (`createdAt`). If the delete rule and this read window ever diverge you get
 * signals that are visible but already scheduled for deletion, or signals
 * retained forever that nobody can see. That is why this lives in its own
 * module rather than as a literal in the query.
 *
 * `syncShippedWorkSignals` (`shipped-work.ts`) is ALSO bound by this window:
 * its candidate select is scoped to atomic updates created within it, and its
 * stale-marking only touches signals whose `createdAt` is within it too.
 * Without that bound, a future purge that deletes rows older than the window
 * would have them silently re-created (with a fresh `createdAt`) by the very
 * next reconciler run, making `shipped_work` signals permanently un-prunable.
 * Whoever builds deletion needs to know the reconciler is already bounded
 * this way, and that this module is the shared definition to extend rather
 * than duplicate.
 *
 * Accepted-brief exemption (spec 5): once `brief_signals` exists and cascades
 * on signal delete, the eventual purge MUST exempt any signal referenced by an
 * accepted brief — those are the evidence trail behind published content, and
 * deleting them would silently break that join. Nothing enforces this yet
 * because nothing deletes yet; this is the note for whoever adds the delete.
 */
export const SIGNAL_WINDOW_DAYS = 60;

/** The oldest `createdAt` still inside the window. */
export function signalWindowStart(now: Date): Date {
  return new Date(now.getTime() - SIGNAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * The reusable `signals.createdAt` window condition. Lives here (not
 * `query.ts`) because this module is the single definition the window is
 * meant to never drift from — `listSignals` uses it today, and spec 5's
 * ideation read must reuse this export rather than re-deriving the same
 * `gte(signals.createdAt, signalWindowStart(...))` expression a second time.
 */
export function signalWindowCondition(now: Date = new Date()): SQL {
  return gte(signals.createdAt, signalWindowStart(now));
}
