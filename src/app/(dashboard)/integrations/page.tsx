import { eq } from "drizzle-orm";
import { db } from "@/db";
import { webhookConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { saveWebhookConfig } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const COMING_SOON = ["Webflow", "Customer.io", "Mailchimp", "HubSpot", "LinkedIn"];

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
            <form action={saveWebhookConfig} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="url">URL</Label>
                <Input id="url" type="url" name="url" defaultValue={config?.url ?? ""} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="secret">Secret</Label>
                <Input id="secret" type="text" name="secret" defaultValue={config?.secret ?? ""} required />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="active"
                  defaultChecked={config?.active ?? true}
                  className="size-4 rounded border-input"
                />
                Active
              </label>
              <Button type="submit" variant="outline">
                Save
              </Button>
            </form>
          </CardContent>
        </Card>
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
