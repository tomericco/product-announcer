import { eq } from "drizzle-orm";
import { db } from "@/db";
import { repos, tenants, notionConnections } from "@/db/schema";
import { guardOnboardingStep } from "../guard";
import { StepHeader } from "../steps";
import { addOnboardingRepos, finishConnectStep } from "../actions";
import { listAccessibleRepos, listRepoBranches } from "@/lib/integrations/github/github";
import { RepoRow } from "@/app/(dashboard)/integrations/repo-row";
import { NotionDatabaseForm } from "@/app/(dashboard)/integrations/notion-database-form";
import { fetchNotionDatabases } from "@/app/(dashboard)/integrations/notion-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function ConnectStepPage() {
  const session = await guardOnboardingStep(3);
  const tenantId = session.user.tenantId;

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const [notion] = await db.select().from(notionConnections).where(eq(notionConnections.tenantId, tenantId)).limit(1);
  const tenantRepos = await db.select().from(repos).where(eq(repos.tenantId, tenantId));

  const githubConnected = Boolean(tenant?.githubInstallationId);
  const connected = githubConnected || Boolean(notion);

  const accessibleRepos = tenant?.githubInstallationId
    ? await listAccessibleRepos(tenant.githubInstallationId)
    : [];
  const watchedFullNames = new Set(tenantRepos.map((r) => r.githubRepoFullName));
  const branchesByFullName = new Map<string, string[]>();
  if (tenant?.githubInstallationId) {
    for (const r of accessibleRepos) {
      // Guard each repo's fetch: a transient GitHub error or a missing
      // branch-list permission on ONE repo must not crash the whole step. The
      // Combobox degrades to an empty list and the row still submits its
      // default branch.
      try {
        branchesByFullName.set(r.fullName, await listRepoBranches(tenant.githubInstallationId, r.fullName));
      } catch {
        branchesByFullName.set(r.fullName, []);
      }
    }
  }

  // Notion is only useful once a database is picked, so surface the picker as
  // soon as the connection exists — mirroring the repo sub-step. Skip the
  // fetch (and its potential token-refresh attempt) once a database is
  // already chosen, or when the connection is already known to need
  // re-authorization — in the latter case we show an explanatory line
  // instead of the picker, so listing databases would just be discarded.
  const needsReauth = notion?.status === "needs_reauth";
  const notionDatabases =
    notion && !notion.databaseId && !needsReauth ? await fetchNotionDatabases().catch(() => []) : [];

  return (
    <div className="space-y-8">
      <StepHeader
        step={3}
        title="Connect your work"
        description="We watch these for shipped changes. Connect either one — or both."
      />

      <Card>
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!githubConnected ? (
            <Button variant="outline" render={<a href="/api/github/connect?returnTo=onboarding" />}>
              Connect GitHub
            </Button>
          ) : tenantRepos.length > 0 ? (
            <p className="text-sm">
              Watching {tenantRepos.length} {tenantRepos.length === 1 ? "repo" : "repos"}.
            </p>
          ) : (
            <form action={addOnboardingRepos} className="space-y-3">
              <p className="text-muted-foreground text-sm">Pick the repos to watch.</p>
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
                <p className="text-muted-foreground text-sm">No accessible repos found.</p>
              )}
              <Button type="submit" variant="outline">
                Add selected repos
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notion</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!notion ? (
            <Button variant="outline" render={<a href="/api/notion/connect?returnTo=onboarding" />}>
              Connect Notion
            </Button>
          ) : notion.databaseId ? (
            <p className="text-sm">Using {notion.databaseName ?? "your selected database"}.</p>
          ) : needsReauth ? (
            <p className="text-muted-foreground text-sm">
              Your Notion connection needs to be reconnected. Head to Integrations to reconnect it.
            </p>
          ) : (
            <NotionDatabaseForm databases={notionDatabases} currentDatabaseId={notion.databaseId} />
          )}
        </CardContent>
      </Card>

      {/* One control, never two: with nothing connected, "Continue" and "Skip"
          would do exactly the same thing — so the same action backs both, and
          only the label and emphasis change. */}
      <form action={finishConnectStep}>
        <Button
          type="submit"
          variant={connected ? "default" : "ghost"}
          className={connected ? "w-full" : "text-muted-foreground w-full"}
        >
          {connected ? "Continue" : "Skip this step"}
        </Button>
      </form>
    </div>
  );
}
