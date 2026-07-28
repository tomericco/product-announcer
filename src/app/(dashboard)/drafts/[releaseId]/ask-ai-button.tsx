"use client";

import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgentEdit } from "./agent-edit-context";

/** Whole-update entry point, placed next to "Save changes" in the action row.
 * Not disabled while the editor mounts — if clicked too early the modal's
 * submit reports the editor isn't ready. */
export function AskAiButton() {
  const { openWholeEdit } = useAgentEdit();
  return (
    <Button type="button" variant="outline" onClick={() => openWholeEdit()}>
      <Sparkles className="size-4" /> Ask for changes
    </Button>
  );
}
