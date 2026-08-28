import { SettingsTabs, type SettingsTab } from "./settings-tabs";
import { UsageSettings } from "./usage-settings";
import { WorkspaceSettings } from "./workspace-settings";

/**
 * `?tab=` decides the panel and ONLY the active panel's Server Component
 * renders, so the usage tab's queries never run for a tenant reading the
 * workspace cards and vice versa. Workspace is the default, which keeps the
 * sidebar's existing `/settings#ai-engines` links landing on their cards.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const active: SettingsTab = tab === "usage" ? "usage" : "workspace";

  return (
    <div className="space-y-6">
      <SettingsTabs active={active} />
      {active === "usage" ? <UsageSettings /> : <WorkspaceSettings />}
    </div>
  );
}
