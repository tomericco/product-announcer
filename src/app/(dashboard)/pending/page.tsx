import { eq } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { repos, scheduleConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getPendingChangeItems } from "@/lib/change-item-batch";
import { dropChangeItem, runNow } from "./actions";

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
        <p className="text-sm text-gray-600">
          Onboarding was skipped without connecting a repo. Add one from{" "}
          <Link href="/settings" className="text-gray-900 underline">
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
        <div className="flex gap-4">
          {tenantRepos.map((r) => (
            <Link
              key={r.id}
              href={`/pending?repoId=${r.id}`}
              className={r.id === activeRepo.id ? "font-semibold underline" : "text-gray-500"}
            >
              {r.githubRepoFullName}
            </Link>
          ))}
        </div>
      )}

      <h1 className="text-xl font-semibold">
        {activeRepo.githubRepoFullName} <span className="text-sm text-gray-500">({activeRepo.watchedBranch})</span>
      </h1>
      <p className="text-sm text-gray-600">
        Next scheduled update: {config?.nextScheduledAt ? config.nextScheduledAt.toLocaleString() : "not scheduled"}
        {" · "}Threshold: {config?.threshold ?? "none"}
      </p>

      <form action={runNow}>
        <input type="hidden" name="repoId" value={activeRepo.id} />
        <button type="submit" disabled={pending.length === 0} className="border px-4 py-2 disabled:opacity-50">
          Run now ({pending.length} pending)
        </button>
      </form>

      <ul className="space-y-2">
        {pending.map((item) => (
          <li key={item.id} className="flex items-center justify-between border p-3">
            <span>{item.sourceType === "pr" ? item.prTitle : item.commitMessage}</span>
            <form action={dropChangeItem}>
              <input type="hidden" name="changeItemId" value={item.id} />
              <input type="hidden" name="repoId" value={activeRepo.id} />
              <button type="submit" className="text-sm text-gray-500 underline">
                Drop
              </button>
            </form>
          </li>
        ))}
        {pending.length === 0 && <li className="text-gray-500">Nothing pending.</li>}
      </ul>
    </div>
  );
}
