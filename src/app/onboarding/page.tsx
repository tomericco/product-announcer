import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { repos, tenants } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getGithubApp, listAccessibleRepos, listRepoBranches } from "@/lib/github";
import { isOnboardingComplete } from "@/lib/onboarding";
import { addOnboardingRepos, saveOnboardingSchedule, skipOnboarding, saveWorkspaceName } from "./actions";
import { RepoRow } from "@/app/(dashboard)/settings/repo-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default async function OnboardingPage() {
  const session = await requireSession();
  if (await isOnboardingComplete(session.user.tenantId)) redirect("/pending");

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);
  const tenantRepos = await db.select().from(repos).where(eq(repos.tenantId, session.user.tenantId));

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
  const branchesByFullName = new Map<string, string[]>();
  if (tenant?.githubInstallationId) {
    for (const r of accessibleRepos) {
      branchesByFullName.set(r.fullName, await listRepoBranches(tenant.githubInstallationId, r.fullName));
    }
  }

  return (
    <main className="mx-auto max-w-lg space-y-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Set up Product Announcer</h1>
        <form action={skipOnboarding}>
          <Button type="submit" variant="ghost" className="text-muted-foreground">
            Skip for now
          </Button>
        </form>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. Name your workspace</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={saveWorkspaceName} className="flex gap-2">
            <Input name="name" defaultValue={tenant?.name ?? ""} className="flex-1" />
            <Button type="submit" variant="outline">
              Save
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className={tenant?.githubInstallationId ? "opacity-60" : ""}>
        <CardHeader>
          <CardTitle>2. Connect GitHub</CardTitle>
        </CardHeader>
        <CardContent>
          {tenant?.githubInstallationId ? (
            <p className="text-sm">Connected.</p>
          ) : installUrl ? (
            <Button variant="outline" render={<a href={installUrl} />}>
              Connect GitHub
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">GitHub integration isn&apos;t configured yet.</p>
          )}
        </CardContent>
      </Card>

      {tenant?.githubInstallationId && tenantRepos.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>3. Select repos to watch</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={addOnboardingRepos} className="space-y-3">
              <input type="hidden" name="repoCount" value={accessibleRepos.length} />
              {accessibleRepos.map((repo, i) => (
                <RepoRow
                  key={repo.fullName}
                  index={i}
                  fullName={repo.fullName}
                  branches={branchesByFullName.get(repo.fullName) ?? []}
                  defaultBranch={repo.defaultBranch}
                  defaultChecked={watchedFullNames.has(repo.fullName)}
                />
              ))}
              {accessibleRepos.length === 0 && (
                <p className="text-sm text-muted-foreground">No accessible repos found.</p>
              )}
              <Button type="submit" variant="outline">
                Add selected repos
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {tenantRepos.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>4. Set your workspace schedule</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={saveOnboardingSchedule} className="space-y-4">
              <div className="space-y-2">
                <Label>Cadence</Label>
                <Select name="cadence" defaultValue="weekly">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="none">No fixed cadence (threshold only)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="threshold">Or after at least this many changes</Label>
                <Input id="threshold" type="number" name="threshold" min={1} defaultValue={5} />
              </div>
              <Button type="submit" variant="outline">
                Finish setup
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
