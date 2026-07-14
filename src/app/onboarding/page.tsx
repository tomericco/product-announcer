import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { repos, tenants } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getGithubApp, listAccessibleRepos } from "@/lib/github";
import { isOnboardingComplete } from "@/lib/onboarding";
import { addOnboardingRepos, saveOnboardingSchedule, skipOnboarding, saveWorkspaceName } from "./actions";

export default async function OnboardingPage() {
  const session = await requireSession();

  // One-time gate: a tenant that already finished (or skipped) onboarding must
  // not re-enter this flow (bookmark, browser-back, manual URL). Re-running
  // "Finish setup" would insert a second scheduleConfigs row per repo — there's
  // no unique constraint on repoId — causing double generation and Settings/
  // scheduler divergence. This mirrors the (dashboard) layout's gate.
  if (await isOnboardingComplete(session.user.tenantId)) redirect("/pending");

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);
  const tenantRepos = await db.select().from(repos).where(eq(repos.tenantId, session.user.tenantId));

  // Deriving the install URL constructs the GitHub App, which throws if
  // GITHUB_APP_ID isn't configured yet. Degrade gracefully so the page still
  // renders (and "Skip for now" stays usable) before the App is set up.
  let installUrl: string | null = null;
  if (!tenant?.githubInstallationId) {
    try {
      installUrl = await getGithubApp().getInstallationUrl({ state: `${session.user.tenantId}|onboarding` });
    } catch {
      installUrl = null;
    }
  }

  const accessibleRepos = tenant?.githubInstallationId ? await listAccessibleRepos(tenant.githubInstallationId) : [];
  const watchedFullNames = new Set(tenantRepos.map((r) => r.githubRepoFullName));

  return (
    <main className="mx-auto max-w-lg p-8 space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Set up Product Announcer</h1>
        <form action={skipOnboarding}>
          <button type="submit" className="text-sm text-gray-500 underline">
            Skip for now
          </button>
        </form>
      </div>

      <section>
        <h2 className="font-medium mb-2">1. Name your workspace</h2>
        <form action={saveWorkspaceName} className="flex gap-2">
          <input
            type="text"
            name="name"
            defaultValue={tenant?.name ?? ""}
            className="flex-1 border p-2"
          />
          <button type="submit" className="border px-4 py-2">
            Save
          </button>
        </form>
      </section>

      <section className={tenant?.githubInstallationId ? "opacity-50" : ""}>
        <h2 className="font-medium mb-2">2. Connect GitHub</h2>
        {tenant?.githubInstallationId ? (
          <p>Connected.</p>
        ) : installUrl ? (
          <a href={installUrl} className="text-gray-900 underline">
            Connect GitHub
          </a>
        ) : (
          <p className="text-sm text-gray-500">GitHub integration isn&apos;t configured yet.</p>
        )}
      </section>

      {tenant?.githubInstallationId && tenantRepos.length === 0 && (
        <section>
          <h2 className="font-medium mb-2">3. Select repos to watch</h2>
          <form action={addOnboardingRepos} className="space-y-3">
            <input type="hidden" name="repoCount" value={accessibleRepos.length} />
            {accessibleRepos.map((repo, i) => (
              <div key={repo.fullName} className="flex items-center gap-3">
                <input type="hidden" name={`repo-${i}-fullName`} value={repo.fullName} />
                <label className="flex items-center gap-2">
                  <input type="checkbox" name={`repo-${i}-selected`} defaultChecked={watchedFullNames.has(repo.fullName)} />
                  {repo.fullName}
                </label>
                <input type="text" name={`repo-${i}-branch`} defaultValue={repo.defaultBranch} className="border p-1 w-32" />
              </div>
            ))}
            {accessibleRepos.length === 0 && <p className="text-sm text-gray-500">No accessible repos found.</p>}
            <button type="submit" className="border px-4 py-2">
              Add selected repos
            </button>
          </form>
        </section>
      )}

      {tenantRepos.length > 0 && (
        <section>
          <h2 className="font-medium mb-2">4. Set your schedule</h2>
          <form action={saveOnboardingSchedule} className="space-y-3">
            <label className="block">
              Cadence
              <select name="cadence" defaultValue="weekly" className="block border p-2 w-full">
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Every 2 weeks</option>
                <option value="monthly">Monthly</option>
                <option value="none">No fixed cadence (threshold only)</option>
              </select>
            </label>
            <label className="block">
              Or after at least this many changes
              <input type="number" name="threshold" min={1} defaultValue={5} className="block border p-2 w-full" />
            </label>
            <button type="submit" className="border px-4 py-2">
              Finish setup
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
