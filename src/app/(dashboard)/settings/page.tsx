import { eq } from "drizzle-orm";
import { db } from "@/db";
import { repos, scheduleConfigs, tenants } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getGithubApp, listAccessibleRepos } from "@/lib/github";
import { getOrCreateBrandProfile } from "@/lib/brand-profile";
import { saveWorkspaceName, saveBrandProfile, saveRepoSchedule, addSettingsRepos } from "./actions";
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

export default async function SettingsPage() {
  const session = await requireSession();
  const brandProfile = await getOrCreateBrandProfile(session.user.tenantId);
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);
  const tenantRepos = await db.select().from(repos).where(eq(repos.tenantId, session.user.tenantId));
  const tenantSchedules = await db
    .select()
    .from(scheduleConfigs)
    .where(eq(scheduleConfigs.tenantId, session.user.tenantId));

  let installUrl: string | null = null;
  if (!tenant?.githubInstallationId) {
    try {
      installUrl = await getGithubApp().getInstallationUrl({ state: `${session.user.tenantId}|settings` });
    } catch {
      installUrl = null;
    }
  }
  const accessibleRepos = tenant?.githubInstallationId ? await listAccessibleRepos(tenant.githubInstallationId) : [];
  const watchedBranchByFullName = new Map(tenantRepos.map((r) => [r.githubRepoFullName, r.watchedBranch]));

  return (
    <div className="space-y-8">
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Workspace name</CardTitle>
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

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>GitHub repos</CardTitle>
        </CardHeader>
        <CardContent>
          {!tenant?.githubInstallationId ? (
            installUrl ? (
              <Button variant="outline" render={<a href={installUrl} />}>
                Connect GitHub
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">GitHub integration isn&apos;t configured yet.</p>
            )
          ) : (
            <form action={addSettingsRepos} className="space-y-3">
              <input type="hidden" name="repoCount" value={accessibleRepos.length} />
              {accessibleRepos.map((repo, i) => (
                <div key={repo.fullName} className="flex items-center gap-3">
                  <input type="hidden" name={`repo-${i}-fullName`} value={repo.fullName} />
                  <label className="flex flex-1 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name={`repo-${i}-selected`}
                      defaultChecked={watchedBranchByFullName.has(repo.fullName)}
                      className="size-4 rounded border-input"
                    />
                    {repo.fullName}
                  </label>
                  <Input
                    name={`repo-${i}-branch`}
                    defaultValue={watchedBranchByFullName.get(repo.fullName) ?? repo.defaultBranch}
                    className="w-36"
                  />
                </div>
              ))}
              {accessibleRepos.length === 0 && (
                <p className="text-sm text-muted-foreground">No accessible repos found.</p>
              )}
              <Button type="submit" variant="outline">
                Save repo selection
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Brand profile</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={saveBrandProfile} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tone">Tone</Label>
              <Input id="tone" name="tone" defaultValue={brandProfile.tone ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="readingLevel">Reading level</Label>
              <Input id="readingLevel" name="readingLevel" defaultValue={brandProfile.readingLevel ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="industry">Industry</Label>
              <Input id="industry" name="industry" defaultValue={brandProfile.industry ?? ""} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="userPersonas">User personas (comma-separated)</Label>
              <Input id="userPersonas" name="userPersonas" defaultValue={brandProfile.userPersonas.join(", ")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="doList">Do (comma-separated)</Label>
              <Input id="doList" name="doList" defaultValue={brandProfile.doList.join(", ")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dontList">Don&apos;t (comma-separated)</Label>
              <Input id="dontList" name="dontList" defaultValue={brandProfile.dontList.join(", ")} />
            </div>
            <Button type="submit" variant="outline">
              Save
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Schedule per repo</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {tenantRepos.map((repo) => {
            const config = tenantSchedules.find((s) => s.repoId === repo.id);
            return (
              <form key={repo.id} action={saveRepoSchedule} className="space-y-3 rounded-md border p-4">
                <input type="hidden" name="repoId" value={repo.id} />
                <p className="font-medium">
                  {repo.githubRepoFullName}{" "}
                  <span className="text-sm text-muted-foreground">({repo.watchedBranch})</span>
                </p>
                <div className="space-y-2">
                  <Label>Cadence</Label>
                  <Select name="cadence" defaultValue={config?.cadence ?? "weekly"}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                      <SelectItem value="biweekly">Every 2 weeks</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="none">No fixed cadence</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`threshold-${repo.id}`}>Threshold</Label>
                  <Input
                    id={`threshold-${repo.id}`}
                    type="number"
                    name="threshold"
                    min={1}
                    defaultValue={config?.threshold ?? 5}
                  />
                </div>
                <Button type="submit" variant="outline">
                  Save
                </Button>
              </form>
            );
          })}
          {tenantRepos.length === 0 && <p className="text-sm text-muted-foreground">No repos connected yet.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
