import { eq } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { repos, scheduleConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getPendingChangeItems } from "@/lib/change-item-batch";
import { dropChangeItem, runNow } from "./actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default async function PendingPage({
  searchParams,
}: {
  searchParams: Promise<{ repoId?: string }>;
}) {
  const session = await requireSession();
  const { repoId: requestedRepoId } = await searchParams;

  const tenantRepos = await db.select().from(repos).where(eq(repos.tenantId, session.user.tenantId));

  if (tenantRepos.length === 0) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">No repos connected yet</h1>
        <p className="text-sm text-muted-foreground">
          Onboarding was skipped without connecting a repo. Add one from{" "}
          <Link href="/settings" className="font-medium underline">
            Settings
          </Link>{" "}
          to start collecting changes.
        </p>
      </div>
    );
  }

  const activeRepo = tenantRepos.find((r) => r.id === requestedRepoId) ?? tenantRepos[0];

  const [config] = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.repoId, activeRepo.id));
  const pending = await getPendingChangeItems(activeRepo.id);

  return (
    <div className="space-y-6">
      {tenantRepos.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {tenantRepos.map((r) => (
            <Button
              key={r.id}
              variant={r.id === activeRepo.id ? "secondary" : "ghost"}
              size="sm"
              render={<Link href={`/pending?repoId=${r.id}`} />}
            >
              {r.githubRepoFullName}
            </Button>
          ))}
        </div>
      )}

      <div>
        <h1 className="text-xl font-semibold">
          {activeRepo.githubRepoFullName}{" "}
          <span className="text-sm text-muted-foreground">({activeRepo.watchedBranch})</span>
        </h1>
        <p className="text-sm text-muted-foreground">
          Next scheduled update:{" "}
          {config?.nextScheduledAt ? config.nextScheduledAt.toLocaleString() : "not scheduled"}
          {" · "}Threshold: {config?.threshold ?? "none"}
        </p>
      </div>

      <form action={runNow}>
        <input type="hidden" name="repoId" value={activeRepo.id} />
        <Button type="submit" disabled={pending.length === 0}>
          Run now ({pending.length} pending)
        </Button>
      </form>

      <div className="space-y-2">
        {pending.map((item) => (
          <Card key={item.id}>
            <CardContent className="flex items-center justify-between gap-4 py-3">
              <span>{item.sourceType === "pr" ? item.prTitle : item.commitMessage}</span>
              <form action={dropChangeItem}>
                <input type="hidden" name="changeItemId" value={item.id} />
                <input type="hidden" name="repoId" value={activeRepo.id} />
                <Button type="submit" variant="ghost" size="sm" className="text-muted-foreground">
                  Drop
                </Button>
              </form>
            </CardContent>
          </Card>
        ))}
        {pending.length === 0 && <p className="text-sm text-muted-foreground">Nothing pending.</p>}
      </div>
    </div>
  );
}
