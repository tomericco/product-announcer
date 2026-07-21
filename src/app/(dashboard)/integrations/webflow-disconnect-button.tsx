"use client";

import { useState } from "react";
import { toast } from "sonner";
import { disconnectWebflow } from "./actions";
import { Button } from "@/components/ui/button";

export function WebflowDisconnectButton() {
  const [submitting, setSubmitting] = useState(false);

  async function handleDisconnect() {
    setSubmitting(true);
    try {
      await disconnectWebflow();
      toast.success("Webflow disconnected");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not disconnect Webflow");
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
