import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { repos, changeItems } from "../db/schema";
import { truncateDiff } from "./github";

export type CommitSelection = {
  repoId: string;
  sha: string;
  message: string;
  url: string;
  committedAt: string | null;
};

export type GetCommitDiff = (
  installationId: string,
  repoFullName: string,
  sha: string
) => Promise<string>;

/**
 * Imports user-selected commits as pending commit-sourced change items.
 *
 * Unlike push ingestion, this ignores the repo's configured `sourceTypes` — the
 * user is explicitly choosing these commits. Each repo is loaded tenant-scoped
 * (IDOR guard), the diff is fetched per commit, and inserts use
 * onConflictDoNothing so re-importing an already-imported commit is a no-op.
 * Returns how many commits were newly inserted.
 */
export async function importSelectedCommits(
  input: { tenantId: string; selections: CommitSelection[] },
  getCommitDiff: GetCommitDiff,
  database: typeof defaultDb = defaultDb
): Promise<{ importedCount: number }> {
  if (input.selections.length === 0) return { importedCount: 0 };

  const byRepo = new Map<string, CommitSelection[]>();
  for (const selection of input.selections) {
    const list = byRepo.get(selection.repoId) ?? [];
    list.push(selection);
    byRepo.set(selection.repoId, list);
  }

  let importedCount = 0;

  for (const [repoId, selections] of byRepo) {
    const [repo] = await database
      .select()
      .from(repos)
      .where(and(eq(repos.id, repoId), eq(repos.tenantId, input.tenantId)))
      .limit(1);
    if (!repo) continue;

    for (const selection of selections) {
      const rawDiff = await getCommitDiff(repo.githubInstallationId, repo.githubRepoFullName, selection.sha);

      const inserted = await database
        .insert(changeItems)
        .values({
          tenantId: input.tenantId,
          repoId: repo.id,
          sourceType: "commit",
          commitSha: selection.sha,
          commitMessage: selection.message,
          commitUrl: selection.url,
          committedAt: selection.committedAt ? new Date(selection.committedAt) : null,
          diff: truncateDiff(rawDiff),
        })
        .onConflictDoNothing()
        .returning({ id: changeItems.id });

      importedCount += inserted.length;
    }
  }

  return { importedCount };
}
