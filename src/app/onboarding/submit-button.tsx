"use client";

import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Submit button that shows a spinner while its own form is in flight.
 *
 * Step 2's import is the slow one: it fetches the user's changelog page and
 * runs an LLM over it, which takes seconds. Without this the button looks dead
 * on click and invites a second press.
 *
 * `useFormStatus` reports the state of the ENCLOSING <form>, so this must be
 * rendered inside the form it submits — it reads nothing from a sibling form.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className={className} disabled={pending}>
      {pending ? (
        <>
          <Loader2 className="size-4 animate-spin" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}

/**
 * A secondary action that submits the SAME form to a different server action.
 *
 * It lives inside the primary form rather than a sibling one specifically so
 * `useFormStatus` can see the primary submission and disable this button while
 * an import is in flight — a sibling form reports its own state only, and would
 * stay clickable mid-import.
 *
 * `formNoValidate` is what makes that possible: the enclosing form marks the URL
 * input `required`, and without it the browser would block skipping whenever the
 * field is empty — which is exactly when someone wants to skip.
 */
export function SecondaryFormAction({
  children,
  action,
  className,
}: {
  children: React.ReactNode;
  action: (formData: FormData) => void | Promise<void>;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" formAction={action} formNoValidate variant="ghost" disabled={pending} className={className}>
      {children}
    </Button>
  );
}
