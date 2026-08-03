"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { useUnsavedChanges } from "../../unsaved-changes";
import { rejectDraft } from "../actions";

// Defense in depth against a double-click: `useFormStatus` reports whether
// the enclosing <form> has a submission in flight, so the buttons disable for
// the duration of either action. Not the guarantee — server actions are
// public endpoints; the real fix is the published_at compare-and-swap in
// actions.ts.
//
// Save is additionally gated on there being something to save: the same
// per-field dirty tracking that arms the leave-confirmation. It re-baselines
// on every commit, so the button goes back to disabled after a save and stays
// disabled if an edit is typed and then undone.
export function SaveChangesButton() {
  const { pending } = useFormStatus();
  const { isDirty } = useUnsavedChanges();
  return (
    <Button type="submit" variant="ghost" disabled={pending || !isDirty}>
      Save changes
    </Button>
  );
}

export function RejectButton() {
  const { pending } = useFormStatus();
  return (
    // formAction overrides the form's default action (saveDraft) for this
    // button only. rejectDraft reads just contentPieceId (a hidden field in
    // the form), so submitting the whole form here is harmless.
    <Button
      type="submit"
      formAction={rejectDraft}
      variant="ghost"
      disabled={pending}
      className="text-muted-foreground hover:text-destructive"
    >
      Reject
    </Button>
  );
}
