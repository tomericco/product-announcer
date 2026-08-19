"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { dismissFailedIllustrations, retryFailedIllustration } from "./illustration-actions";

/**
 * One failed image's Retry. Server-side render + splice (~10-30 s), so
 * a pending state on the button rather than an optimistic update — same
 * shape as `CatchUpBanner`. `router.refresh()` re-runs the page's Server
 * Component so the notice drops the row and the editor's `defaultValue`
 * carries the spliced body on the next mount.
 */
export function RetryIllustrationButton({ contentPieceId, imageId }: { contentPieceId: string; imageId: string }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          const result = await retryFailedIllustration({ contentPieceId, imageId });
          if (!result.ok) {
            toast.error(result.error);
            return;
          }
          toast.success(
            result.placed
              ? "Image added to the draft"
              : "Image generated, but its section heading is gone — insert it from the image library"
          );
          router.refresh();
        })
      }
    >
      {isPending ? "Generating…" : "Retry"}
    </Button>
  );
}

/**
 * The notice's dismiss X — same affordance as WebflowCodeWarning's dismiss
 * (ghost, icon-xs, aria-label). Discards the failed rows for good; no confirm,
 * because nothing the user made is lost (only concepts the agent failed to
 * draw, recoverable by generating fresh from the editor).
 */
export function DismissIllustrationsButton({ contentPieceId }: { contentPieceId: string }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-label="Dismiss"
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          const result = await dismissFailedIllustrations({ contentPieceId });
          if (!result.ok) {
            toast.error(result.error);
            return;
          }
          router.refresh();
        })
      }
    >
      <X className="size-3.5" />
    </Button>
  );
}
