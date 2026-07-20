import { Suspense } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { webhookConfigs } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { WebhookConfigForm } from "./webhook-config-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WebflowForm } from "./webflow-form";

const COMING_SOON = ["Customer.io", "Mailchimp", "HubSpot", "LinkedIn"];

// WebflowForm is an async Server Component that awaits a Webflow HTTP call
// (up to a 10s timeout). Without a boundary, that await blocks this entire
// page's render — the webhook card above would sit unrendered too. This
// fallback keeps the same card shape so nothing jumps when it resolves.
function WebflowFormSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Webflow CMS</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Loading Webflow…</p>
      </CardContent>
    </Card>
  );
}

export default async function IntegrationsPage() {
  const session = await requireSession();
  const [config] = await db.select().from(webhookConfigs).where(eq(webhookConfigs.tenantId, session.user.tenantId));

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <h1 className="text-xl font-semibold">Integrations</h1>
        <Card>
          <CardHeader>
            <CardTitle>Generic Webhook</CardTitle>
          </CardHeader>
          <CardContent>
            <WebhookConfigForm config={config ? { url: config.url, active: config.active } : null} />
          </CardContent>
        </Card>

        <Suspense fallback={<WebflowFormSkeleton />}>
          <WebflowForm />
        </Suspense>
      </section>

      <section className="space-y-2">
        <h2 className="font-medium">Coming soon</h2>
        <div className="flex flex-wrap gap-2">
          {COMING_SOON.map((name) => (
            <Badge key={name} variant="outline" className="opacity-60">
              {name}
            </Badge>
          ))}
        </div>
      </section>
    </div>
  );
}
