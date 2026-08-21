"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DisabledHint } from "../_components/disabled-hint";
import { generatePromptSetAction } from "./actions";

/**
 * Drafts the prompt set. One model call, so it is always a click and never a
 * page load — the design is explicit that generation must not happen behind
 * the human's back, because it costs money.
 *
 * On failure the toast is the whole report and the surface does not change:
 * the empty state (or the prompts list) stays exactly as it was, so the
 * retry is the same button in the same place.
 */
export function GeneratePromptSetButton({
  disabledReason,
  label = "Generate prompt set",
}: {
  disabledReason: string | null;
  label?: string;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (disabledReason) {
    return (
      <div className="flex flex-col items-center gap-1">
        <DisabledHint hint={disabledReason}>
          <Button disabled>{label}</Button>
        </DisabledHint>
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
      </div>
    );
  }

  return (
    <Button
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await generatePromptSetAction();
          if (result.ok) {
            toast.success(`${result.proposed} prompts drafted — review them`);
            router.push("/ai-visibility/prompts");
          } else {
            toast.error(result.error);
          }
        })
      }
    >
      {pending ? "Drafting prompts…" : label}
    </Button>
  );
}
