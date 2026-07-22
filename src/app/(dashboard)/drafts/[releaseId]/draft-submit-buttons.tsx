"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { approveDraft } from "../actions";

// Defense in depth against a double-click: `useFormStatus` reports whether
// the enclosing <form> has a submission in flight, so both buttons disable
// for the duration of either action. This is a UX nicety, not the guarantee
// — server actions are public endpoints a double-click (or a replayed
// request) can still reach directly, so the actual fix is the published_at
// compare-and-swap in actions.ts.
export function SaveChangesButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="ghost" disabled={pending}>
      Save changes
    </Button>
  );
}

export function ApproveButton() {
  const { pending } = useFormStatus();
  return (
    // formAction overrides the form's default action (saveDraft) for this
    // button only, so approving submits the same title/body the user is
    // currently looking at instead of whatever was last saved to the DB.
    <Button type="submit" formAction={approveDraft} disabled={pending}>
      {pending ? "Publishing…" : "Approve & publish"}
    </Button>
  );
}
