"use client";

import { useState } from "react";
import { toast } from "sonner";
import { disconnectLinkedin } from "./linkedin-actions";
import { Button } from "@/components/ui/button";

export function LinkedinDisconnectButton() {
  const [submitting, setSubmitting] = useState(false);

  async function handleDisconnect() {
    setSubmitting(true);
    try {
      await disconnectLinkedin();
      toast.success("LinkedIn disconnected");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not disconnect LinkedIn");
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
