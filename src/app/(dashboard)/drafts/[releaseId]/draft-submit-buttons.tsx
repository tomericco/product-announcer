"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { rejectDraft } from "../actions";

// Defense in depth against a double-click: `useFormStatus` reports whether
// the enclosing <form> has a submission in flight, so the buttons disable for
// the duration of either action. Not the guarantee — server actions are
// public endpoints; the real fix is the published_at compare-and-swap in
// actions.ts.
export function SaveChangesButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ghost" disabled={pending}>
      Save changes
    </Button>
  );
}

export function RejectButton() {
  const { pending } = useFormStatus();
  return (
    // formAction overrides the form's default action (saveDraft) for this
    // button only. rejectDraft reads just releaseId (a hidden field in the
    // form), so submitting the whole form here is harmless.
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
