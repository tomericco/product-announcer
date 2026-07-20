"use client";

import { useState } from "react";
import { toast } from "sonner";
import { fetchWebflowSites } from "./actions";
import { WebflowSiteForm } from "./webflow-site-form";
import type { WebflowSite } from "@/lib/integrations/webflow/client";
import { Button } from "@/components/ui/button";

// Once a site is chosen, the wizard used to have no way back except
// Disconnect — which deletes the encrypted token. Since Webflow only shows a
// Site API token once, that's a trap for a mis-click. This re-shows the
// existing WebflowSiteForm on demand; saving it runs saveWebflowSite, which
// already clears the (now-invalid) collection and mapping.
export function WebflowChangeSite({ currentSiteName }: { currentSiteName: string | null }) {
  const [sites, setSites] = useState<WebflowSite[] | null>(null);
  const [loading, setLoading] = useState(false);

  if (sites) {
    return (
      <div className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">Choose a different Webflow site.</p>
          <Button type="button" variant="ghost" size="sm" onClick={() => setSites(null)}>
            Cancel
          </Button>
        </div>
        <WebflowSiteForm sites={sites} />
      </div>
    );
  }

  async function loadSites() {
    setLoading(true);
    try {
      setSites(await fetchWebflowSites());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load Webflow sites");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground">
        Site: <span className="font-medium text-foreground">{currentSiteName ?? "—"}</span>
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={loadSites} disabled={loading}>
        {loading ? "Loading…" : "Change site"}
      </Button>
    </div>
  );
}
