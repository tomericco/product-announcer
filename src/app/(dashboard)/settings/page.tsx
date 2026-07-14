import { eq } from "drizzle-orm";
import { db } from "@/db";
import { repos, scheduleConfigs, tenants } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getGithubApp, listAccessibleRepos } from "@/lib/github";
import { getOrCreateBrandProfile } from "@/lib/brand-profile";
import { saveWorkspaceName, saveBrandProfile, saveRepoSchedule, addSettingsRepos } from "./actions";

export default async function SettingsPage() {
  const session = await requireSession();
  const brandProfile = await getOrCreateBrandProfile(session.user.tenantId);
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);
  const tenantRepos = await db.select().from(repos).where(eq(repos.tenantId, session.user.tenantId));
  const tenantSchedules = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.tenantId, session.user.tenantId));

  const installUrl = !tenant?.githubInstallationId
    ? await getGithubApp().getInstallationUrl({ state: `${session.user.tenantId}|settings` })
    : null;
  const accessibleRepos = tenant?.githubInstallationId ? await listAccessibleRepos(tenant.githubInstallationId) : [];
  const watchedBranchByFullName = new Map(tenantRepos.map((r) => [r.githubRepoFullName, r.watchedBranch]));

  return (
    <div className="space-y-12">
      <section>
        <h1 className="text-xl font-semibold mb-4">Workspace name</h1>
        <form action={saveWorkspaceName} className="flex max-w-lg gap-2">
          <input type="text" name="name" defaultValue={tenant?.name ?? ""} className="flex-1 border p-2" />
          <button type="submit" className="border px-4 py-2">
            Save
          </button>
        </form>
      </section>

      <section>
        <h1 className="text-xl font-semibold mb-4">GitHub repos</h1>
        {!tenant?.githubInstallationId ? (
          <a href={installUrl ?? "#"} className="text-gray-900 underline">
            Connect GitHub
          </a>
        ) : (
          <form action={addSettingsRepos} className="space-y-3 max-w-lg">
            <input type="hidden" name="repoCount" value={accessibleRepos.length} />
            {accessibleRepos.map((repo, i) => (
              <div key={repo.fullName} className="flex items-center gap-3">
                <input type="hidden" name={`repo-${i}-fullName`} value={repo.fullName} />
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name={`repo-${i}-selected`}
                    defaultChecked={watchedBranchByFullName.has(repo.fullName)}
                  />
                  {repo.fullName}
                </label>
                <input
                  type="text"
                  name={`repo-${i}-branch`}
                  defaultValue={watchedBranchByFullName.get(repo.fullName) ?? repo.defaultBranch}
                  className="border p-1 w-32"
                />
              </div>
            ))}
            {accessibleRepos.length === 0 && <p className="text-sm text-gray-500">No accessible repos found.</p>}
            <button type="submit" className="border px-4 py-2">
              Save repo selection
            </button>
          </form>
        )}
      </section>

      <section>
        <h1 className="text-xl font-semibold mb-4">Brand profile</h1>
        <form action={saveBrandProfile} className="space-y-3 max-w-lg">
          <label className="block">
            Tone
            <input type="text" name="tone" defaultValue={brandProfile.tone ?? ""} className="block w-full border p-2" />
          </label>
          <label className="block">
            Reading level
            <input
              type="text"
              name="readingLevel"
              defaultValue={brandProfile.readingLevel ?? ""}
              className="block w-full border p-2"
            />
          </label>
          <label className="block">
            Industry
            <input
              type="text"
              name="industry"
              defaultValue={brandProfile.industry ?? ""}
              className="block w-full border p-2"
            />
          </label>
          <label className="block">
            User personas (comma-separated)
            <input
              type="text"
              name="userPersonas"
              defaultValue={brandProfile.userPersonas.join(", ")}
              className="block w-full border p-2"
            />
          </label>
          <label className="block">
            Do (comma-separated)
            <input
              type="text"
              name="doList"
              defaultValue={brandProfile.doList.join(", ")}
              className="block w-full border p-2"
            />
          </label>
          <label className="block">
            Don&apos;t (comma-separated)
            <input
              type="text"
              name="dontList"
              defaultValue={brandProfile.dontList.join(", ")}
              className="block w-full border p-2"
            />
          </label>
          <button type="submit" className="border px-4 py-2">
            Save
          </button>
        </form>
      </section>

      <section>
        <h1 className="text-xl font-semibold mb-4">Schedule per repo</h1>
        <div className="space-y-4">
          {tenantRepos.map((repo) => {
            const config = tenantSchedules.find((s) => s.repoId === repo.id);
            return (
              <form key={repo.id} action={saveRepoSchedule} className="border p-4 space-y-2 max-w-md">
                <input type="hidden" name="repoId" value={repo.id} />
                <p className="font-medium">
                  {repo.githubRepoFullName} <span className="text-sm text-gray-500">({repo.watchedBranch})</span>
                </p>
                <label className="block">
                  Cadence
                  <select name="cadence" defaultValue={config?.cadence ?? "weekly"} className="block border p-2 w-full">
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Every 2 weeks</option>
                    <option value="monthly">Monthly</option>
                    <option value="none">No fixed cadence</option>
                  </select>
                </label>
                <label className="block">
                  Threshold
                  <input
                    type="number"
                    name="threshold"
                    min={1}
                    defaultValue={config?.threshold ?? 5}
                    className="block border p-2 w-full"
                  />
                </label>
                <button type="submit" className="border px-4 py-2">
                  Save
                </button>
              </form>
            );
          })}
          {tenantRepos.length === 0 && <p className="text-sm text-gray-500">No repos connected yet.</p>}
        </div>
      </section>
    </div>
  );
}
