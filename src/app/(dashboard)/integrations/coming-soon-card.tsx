"use client";

import { useState } from "react";
import { ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * A not-yet-available integration, shown with an Upvote button. The button is a
 * local toggle only — nothing is persisted or sent anywhere yet; it just lets a
 * user express interest and reflects that back visually.
 */
export function ComingSoonCard({ name }: { name: string }) {
  const [upvoted, setUpvoted] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{name}</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground">Coming soon</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={upvoted}
          onClick={() => setUpvoted((v) => !v)}
          className={cn(upvoted && "border-primary text-primary")}
        >
          <ChevronUp className={cn(upvoted && "text-primary")} />
          {upvoted ? "Upvoted" : "Upvote"}
        </Button>
      </CardContent>
    </Card>
  );
}
