"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Wraps every route in the (dashboard) group. Without this file, an
// unguarded throw in any server component here (e.g. a decrypt failure, a
// failed fetch) falls through to Next's default, unstyled error page. This
// degrades that to an in-app card instead, matching the rest of the app.
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
    <Card>
      <CardHeader>
        <CardTitle>Something went wrong</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          This page hit an unexpected error. Try again, or use the sidebar to go somewhere else.
        </p>
        <Button type="button" variant="outline" onClick={() => unstable_retry()}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}
