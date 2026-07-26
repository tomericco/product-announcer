"use client";

import { useState } from "react";
import { toast } from "sonner";
import { disconnectNotion } from "./notion-actions";
import { Button } from "@/components/ui/button";

export function NotionDisconnectButton() {
  const [submitting, setSubmitting] = useState(false);

  async function handleDisconnect() {
    setSubmitting(true);
    try {
      await disconnectNotion();
      toast.success("Notion disconnected");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not disconnect Notion");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Button type="button" variant="destructive" onClick={handleDisconnect} disabled={submitting}>
      {submitting ? "Disconnecting…" : "Disconnect"}
    </Button>
  );
}
