/**
 * One Save over an atomic update is three writes — `editAtomicUpdate` for the
 * title/summary, then `setAtomicUpdateSize` and `setAtomicUpdateCategory` for
 * whichever of those actually changed. Both editors (the curation card on
 * /company and the evidence drawer on /signals) run the same sequence, and
 * both used to report it twice: a size call that came back `{ok:false}` for a
 * non-guard reason toasted "Could not update size" and then, immediately
 * after, "Saved". Two contradictory toasts for one click.
 *
 * So the reporting is derived here instead, from the parts that failed: one
 * outcome, one message, per Save. Pure and free of any `db`/React import so
 * both client editors can use it and it stays directly testable (there is no
 * jsdom in this project).
 *
 * Note the guard case is handled earlier and never reaches this: all three
 * writes carry the same `status='open'` guard, so a refused edit means the
 * other two would be refused too, and both callers bail on that before
 * attempting them.
 */

export type SavePart = "size" | "category";

export type SaveOutcome = { ok: boolean; message: string };

const PART_LABEL: Record<SavePart, string> = {
  size: "size",
  category: "category",
};

export function saveOutcomeMessage(failedParts: SavePart[], savedMessage = "Saved"): SaveOutcome {
  if (failedParts.length === 0) return { ok: true, message: savedMessage };

  // Deduplicated and ordered so the message is stable regardless of the order
  // the caller happened to attempt the writes in.
  const parts = (["size", "category"] as SavePart[]).filter((part) => failedParts.includes(part));
  const list = parts.map((part) => PART_LABEL[part]).join(" or ");

  return {
    ok: false,
    // Says what DID persist as well as what didn't: the title and summary are
    // already written by this point, so a bare "couldn't save" would be wrong.
    message: `Saved the title and summary, but couldn't update ${list}`,
  };
}
