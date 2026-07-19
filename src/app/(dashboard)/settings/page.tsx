import { eq } from "drizzle-orm";
import { db } from "@/db";
import { repos, scheduleConfigs, tenants, systemPersonas } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getGithubApp, listAccessibleRepos, listRepoBranches } from "@/lib/integrations/github/github";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { saveWorkspaceName, saveAutoPublish, saveBrandProfile, removeRepo } from "./actions";
import { AddRepoDialog } from "./add-repo-dialog";
import { RepoBranchSelect } from "./repo-branch-select";
import { PersonasEditor } from "./personas-editor";
import { BrandStyleImport } from "./brand-style-import";
import { IndustrySelect } from "./industry-select";
import { ScheduleForm } from "./schedule-form";
import { ToastForm } from "./toast-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

export default async function SettingsPage() {
  const session = await requireSession();
  const brandProfile = await getOrCreateBrandProfile(session.user.tenantId);
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);
  const tenantRepos = await db.select().from(repos).where(eq(repos.tenantId, session.user.tenantId));
  const [workspaceSchedule] = await db
    .select()
    .from(scheduleConfigs)
    .where(eq(scheduleConfigs.tenantId, session.user.tenantId));
  const personaCatalog = await db
    .select({
      key: systemPersonas.key,
      name: systemPersonas.name,
      description: systemPersonas.description,
    })
    .from(systemPersonas)
    .orderBy(systemPersonas.sortOrder);

  let installUrl: string | null = null;
  if (!tenant?.githubInstallationId) {
    try {
      installUrl = await getGithubApp().getInstallationUrl({ state: `${session.user.tenantId}|settings` });
    } catch {
      installUrl = null;
    }
  }
  const accessibleRepos = tenant?.githubInstallationId ? await listAccessibleRepos(tenant.githubInstallationId) : [];
  const connectedFullNames = new Set(tenantRepos.map((r) => r.githubRepoFullName));
  const availableAccessible = accessibleRepos.filter((r) => !connectedFullNames.has(r.fullName));

  // Branch lists power both the per-repo branch selector (connected repos) and the
  // Add-repo picker (not-yet-connected repos). One guarded fetch per repo — a
  // transient GitHub error on ONE repo must not crash the whole Settings page; it
  // simply degrades to an empty branch list for that repo.
  const branchesByFullName = new Map<string, string[]>();
  if (tenant?.githubInstallationId) {
    const fullNames = [
      ...tenantRepos.map((r) => r.githubRepoFullName),
      ...availableAccessible.map((r) => r.fullName),
    ];
    for (const fullName of fullNames) {
      try {
        branchesByFullName.set(fullName, await listRepoBranches(tenant.githubInstallationId, fullName));
      } catch {
        branchesByFullName.set(fullName, []);
      }
    }
  }

  const availableRepos = availableAccessible.map((r) => ({
    fullName: r.fullName,
    defaultBranch: r.defaultBranch,
    branches: branchesByFullName.get(r.fullName) ?? [],
  }));

  return (
    <div className="space-y-8">
      <Card>
        <CardHeader>
          <CardTitle>Workspace name</CardTitle>
        </CardHeader>
        <CardContent>
          <ToastForm action={saveWorkspaceName} successMessage="Workspace name saved" className="flex gap-2">
            <Input name="name" defaultValue={tenant?.name ?? ""} className="flex-1" />
            <Button type="submit" variant="outline">
              Save
            </Button>
          </ToastForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Auto-publish</CardTitle>
        </CardHeader>
        <CardContent>
          <ToastForm action={saveAutoPublish} successMessage="Auto-publish updated" className="space-y-3">
            <label className="flex items-center gap-3 text-sm">
              <Switch name="autoPublish" defaultChecked={tenant?.autoPublish ?? false} />
              Publish generated updates automatically
            </label>
            <p className="text-xs text-muted-foreground">
              When on, generated updates are published to your webhook immediately and skip the Drafts
              review queue. Requires an active webhook — without one, updates still land in Drafts for review.
            </p>
            <Button type="submit" variant="outline">
              Save
            </Button>
          </ToastForm>
        </CardContent>
      </Card>

      <Card>
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
            <div className="space-y-4">
              {tenantRepos.length > 0 ? (
                <ul className="divide-y divide-border">
                  {tenantRepos.map((repo) => (
                    <li
                      key={repo.id}
                      className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {repo.githubRepoFullName}
                      </span>
                      <RepoBranchSelect
                        repoId={repo.id}
                        currentBranch={repo.watchedBranch}
                        branches={branchesByFullName.get(repo.githubRepoFullName) ?? []}
                      />
                      <ToastForm action={removeRepo} successMessage="Repo removed">
                        <input type="hidden" name="repoId" value={repo.id} />
                        <Button type="submit" variant="ghost" size="sm" className="text-muted-foreground">
                          Remove
                        </Button>
                      </ToastForm>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No repos connected yet.</p>
              )}
              <AddRepoDialog availableRepos={availableRepos} />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Brand profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <BrandStyleImport defaultUrl={brandProfile.updatesPageUrl ?? ""} />
          <ToastForm action={saveBrandProfile} successMessage="Brand profile saved" className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tone">Tone</Label>
              <Textarea id="tone" name="tone" rows={3} defaultValue={brandProfile.tone ?? ""} />
            </div>
            <div className="space-y-2">
              <Label>Industry</Label>
              <IndustrySelect defaultValue={brandProfile.industry ?? ""} />
            </div>
            <div className="space-y-2">
              <Label>User personas</Label>
              <PersonasEditor personas={brandProfile.userPersonas} catalog={personaCatalog} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="doList">Do</Label>
              <Textarea
                id="doList"
                name="doList"
                rows={3}
                placeholder="One per line"
                defaultValue={brandProfile.doList.join("\n")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dontList">Don&apos;t</Label>
              <Textarea
                id="dontList"
                name="dontList"
                rows={3}
                placeholder="One per line"
                defaultValue={brandProfile.dontList.join("\n")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="updatesStyleSummary">Updates page style summary</Label>
              <Textarea
                id="updatesStyleSummary"
                name="updatesStyleSummary"
                rows={3}
                defaultValue={brandProfile.updatesStyleSummary ?? ""}
              />
            </div>
            <Button type="submit" variant="outline">
              Save
            </Button>
          </ToastForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Publishing schedule</CardTitle>
        </CardHeader>
        <CardContent>
          <ScheduleForm
            defaults={{
              cadence: workspaceSchedule?.cadence ?? "weekly",
              threshold: workspaceSchedule?.threshold ?? null,
              thresholdEnabled: workspaceSchedule?.thresholdEnabled ?? false,
              hour: workspaceSchedule?.hour ?? 9,
              dayOfWeek: workspaceSchedule?.dayOfWeek ?? null,
              dayOfMonth: workspaceSchedule?.dayOfMonth ?? null,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
