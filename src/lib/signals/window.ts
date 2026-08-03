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
 */
export const SIGNAL_WINDOW_DAYS = 60;

/** The oldest `createdAt` still inside the window. */
export function signalWindowStart(now: Date): Date {
  return new Date(now.getTime() - SIGNAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}
