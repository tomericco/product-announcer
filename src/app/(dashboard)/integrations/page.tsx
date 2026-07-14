import { eq } from "drizzle-orm";
import { db } from "@/db";
import { webhookConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { saveWebhookConfig } from "./actions";

const COMING_SOON = ["Webflow", "Customer.io", "Mailchimp", "HubSpot", "LinkedIn"];

export default async function IntegrationsPage() {
  const session = await requireSession();
  const [config] = await db.select().from(webhookConfigs).where(eq(webhookConfigs.tenantId, session.user.tenantId));

  return (
    <div className="space-y-10">
      <section>
        <h1 className="text-xl font-semibold mb-4">Integrations</h1>
        <div className="border p-4 max-w-lg space-y-3">
          <p className="font-medium">Generic Webhook</p>
          <form action={saveWebhookConfig} className="space-y-3">
            <label className="block">
              URL
              <input type="url" name="url" defaultValue={config?.url ?? ""} required className="block w-full border p-2" />
            </label>
            <label className="block">
              Secret
              <input type="text" name="secret" defaultValue={config?.secret ?? ""} required className="block w-full border p-2" />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="active" defaultChecked={config?.active ?? true} />
              Active
            </label>
            <button type="submit" className="border px-4 py-2">
              Save
            </button>
          </form>
        </div>
      </section>

      <section>
        <h2 className="font-medium mb-2">Coming soon</h2>
        <ul className="flex gap-3">
          {COMING_SOON.map((name) => (
            <li key={name} className="border px-3 py-2 opacity-50">
              {name}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
