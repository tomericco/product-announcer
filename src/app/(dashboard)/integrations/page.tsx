import { Suspense } from "react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { repos, tenants, webhookConfigs } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getGithubApp, listAccessibleRepos, listRepoBranches } from "@/lib/integrations/github/github";
import { removeRepo } from "./actions";
import { AddRepoDialog } from "./add-repo-dialog";
import { RepoBranchSelect } from "./repo-branch-select";
import { ToastForm } from "../settings/toast-form";
import { WebhookConfigForm } from "./webhook-config-form";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WebflowForm } from "./webflow-form";
import { NotionForm } from "./notion-form";
import { LinkedinForm } from "./linkedin-form";

const COMING_SOON = ["Customer.io", "Mailchimp", "HubSpot"];

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

// Same rationale as WebflowFormSkeleton above: NotionForm awaits a Notion
// HTTP call (up to a 10s timeout) and must not block the rest of the page.
function NotionFormSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notion tasks</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Loading Notion…</p>
      </CardContent>
    </Card>
  );
}

// Same rationale as WebflowFormSkeleton above: LinkedinForm awaits a LinkedIn
// HTTP call (up to a 10s timeout) and must not block the rest of the page.
function LinkedinFormSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>LinkedIn company page</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Loading LinkedIn…</p>
      </CardContent>
    </Card>
  );
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  // Surface a LinkedIn OAuth failure reason passed back by the callback route
  // (e.g. unauthorized_scope_error) instead of failing silently.
  const linkedinError =
    sp.linkedin_connect === "error"
      ? typeof sp.reason === "string" && sp.reason
        ? sp.reason
        : "Could not connect LinkedIn. Please try again."
      : null;
  const [config] = await db.select().from(webhookConfigs).where(eq(webhookConfigs.tenantId, session.user.tenantId));

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);
  const tenantRepos = await db.select().from(repos).where(eq(repos.tenantId, session.user.tenantId));

  let installUrl: string | null = null;
  if (!tenant?.githubInstallationId) {
    try {
      installUrl = await getGithubApp().getInstallationUrl({ state: `${session.user.tenantId}|integrations` });
    } catch {
      installUrl = null;
    }
  }
  const accessibleRepos = tenant?.githubInstallationId ? await listAccessibleRepos(tenant.githubInstallationId) : [];
  const connectedFullNames = new Set(tenantRepos.map((r) => r.githubRepoFullName));
  const availableAccessible = accessibleRepos.filter((r) => !connectedFullNames.has(r.fullName));

  // Branch lists power both the per-repo branch selector (connected repos) and the
  // Add-repo picker (not-yet-connected repos). One guarded fetch per repo — a
  // transient GitHub error on ONE repo must not crash the whole Integrations page; it
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
    <div className="space-y-10">
      <section className="space-y-4">
        <h1 className="text-xl font-semibold">Integrations</h1>
        {linkedinError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            LinkedIn: {linkedinError}
          </div>
        )}
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

        <Suspense fallback={<NotionFormSkeleton />}>
          <NotionForm />
        </Suspense>

        <Suspense fallback={<LinkedinFormSkeleton />}>
          <LinkedinForm />
        </Suspense>

        <Card>
          <CardHeader>
            <CardTitle>GitHub repos</CardTitle>
          </CardHeader>
          <CardContent>
            {!tenant?.githubInstallationId ? (
              installUrl ? (
                <Button variant="outline" render={<a href="/api/github/connect?returnTo=integrations" />}>
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
