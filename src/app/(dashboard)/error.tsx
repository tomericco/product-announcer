"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Wraps every route in the (dashboard) group. Without this file, an unguarded
// throw in any server component here (e.g. a decrypt failure, a failed fetch)
// falls through to Next's default, unstyled error page. This surfaces it as an
// in-app modal instead, matching the rest of the app.
//
// The boundary only replaces the page content, not the (dashboard) layout, so
// the sidebar stays rendered behind the overlay — the modal is deliberately
// non-dismissible (open, close requests ignored, no X), leaving "Try again"
// and the sidebar as the two ways forward rather than a dead empty page.
export default function DashboardError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Something went wrong</DialogTitle>
          <DialogDescription>
            This page hit an unexpected error. Try again, or use the sidebar to go somewhere else.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={() => unstable_retry()}>
            Try again
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
