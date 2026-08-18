"use client";

import { useSyncExternalStore } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

// Remember the dismissal per draft in localStorage so it survives refreshes,
// and read it through useSyncExternalStore so there's no SSR/hydration mismatch
// (the server snapshot is always "not dismissed"). A custom event notifies the
// same tab, since the native "storage" event only fires in *other* tabs.
const DISMISS_EVENT = "webflow-code-warning:change";

function dismiss(storageKey: string) {
  window.localStorage.setItem(storageKey, "1");
  window.dispatchEvent(new Event(DISMISS_EVENT));
}

function useDismissed(storageKey: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("storage", onChange);
      window.addEventListener(DISMISS_EVENT, onChange);
      return () => {
        window.removeEventListener("storage", onChange);
        window.removeEventListener(DISMISS_EVENT, onChange);
      };
    },
    () => window.localStorage.getItem(storageKey) === "1",
    () => false, // server snapshot: nothing is dismissed during SSR
  );
}

/**
 * Warns that a draft's code block will publish to Webflow as plain text. Whether
 * to show it at all is decided server-side (Webflow is a live target AND the body
 * contains a code block); this component only adds the ability to dismiss it.
 */
export function WebflowCodeWarning({ contentPieceId }: { contentPieceId: string }) {
  const storageKey = `webflow-code-warning-dismissed:${contentPieceId}`;
  const dismissed = useDismissed(storageKey);

  if (dismissed) return null;

  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 p-2 text-sm">
      <p className="flex-1">
        This draft contains a code block. Webflow&apos;s rich text field doesn&apos;t support code
        blocks, so it will be published as plain formatted text.
      </p>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss"
        className="-my-0.5 shrink-0 text-muted-foreground hover:bg-amber-500/20"
        onClick={() => dismiss(storageKey)}
      >
        <X />
      </Button>
    </div>
  );
}
