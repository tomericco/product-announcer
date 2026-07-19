"use server";

import { and, eq, inArray, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { changeItems, repos } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getCommitDiff, listRepoCommits } from "@/lib/integrations/github/github";
import { importSelectedCommits, type CommitSelection } from "@/lib/change-items/import-commits";

export async function dropChangeItem(formData: FormData) {
  const session = await requireSession();
  const changeItemId = formData.get("changeItemId") as string;

  // Scope the mutation to the change item AND the caller's tenant so a caller
  // can only ever exclude their own rows.
  await db
    .update(changeItems)
    .set({ status: "excluded", excludedAt: new Date(), excludedBy: session.user.id })
    .where(and(eq(changeItems.id, changeItemId), eq(changeItems.tenantId, session.user.tenantId)));

  revalidatePath("/pending");
}

export async function includeChangeItem(formData: FormData) {
  const session = await requireSession();
  const changeItemId = formData.get("changeItemId") as string;

  // Force-include: the user is overriding the classifier. Scope to the caller's
  // tenant so a caller can only ever flip their own rows.
  await db
    .update(changeItems)
    .set({ userFacing: true })
    .where(and(eq(changeItems.id, changeItemId), eq(changeItems.tenantId, session.user.tenantId)));

  revalidatePath("/pending");
}

export type ImportableCommit = {
  repoId: string;
  repoFullName: string;
  sha: string;
  message: string;
  url: string;
  committedAt: string | null;
  authorName: string | null;
  imported: boolean;
};

export async function listImportableCommits(input: {
  repoIds: string[];
  since?: string;
  until?: string;
}): Promise<{ commits: ImportableCommit[] }> {
  const session = await requireSession();
  if (input.repoIds.length === 0) return { commits: [] };

  // Load only the caller's repos among those requested (tenant-scoped IDOR guard).
  const ownedRepos = await db
    .select()
    .from(repos)
    .where(and(eq(repos.tenantId, session.user.tenantId), inArray(repos.id, input.repoIds)));

  const perRepo = await Promise.all(
    ownedRepos.map(async (repo) => {
      // Guard each repo's fetch so one failing repo doesn't blank out the whole
      // "All" view — it just contributes no commits.
      let commits;
      try {
        commits = await listRepoCommits(repo.githubInstallationId, repo.githubRepoFullName, repo.watchedBranch, {
          since: input.since,
          until: input.until,
        });
      } catch {
        return [] as ImportableCommit[];
      }

      const shas = commits.map((c) => c.sha);
      // A dropped commit keeps an `excluded` change_item row; don't count those as
      // imported, so it shows up here as re-importable again.
      const existing = shas.length
        ? await db
            .select({ sha: changeItems.commitSha })
            .from(changeItems)
            .where(
              and(
                eq(changeItems.repoId, repo.id),
                inArray(changeItems.commitSha, shas),
                ne(changeItems.status, "excluded")
              )
            )
        : [];
      const importedShas = new Set(existing.map((e) => e.sha));

      return commits.map((c) => ({
        repoId: repo.id,
        repoFullName: repo.githubRepoFullName,
        sha: c.sha,
        message: c.message,
        url: c.url,
        committedAt: c.committedAt,
        authorName: c.authorName,
        imported: importedShas.has(c.sha),
      }));
    })
  );

  const commits = perRepo.flat().sort((a, b) => {
    const ta = a.committedAt ? Date.parse(a.committedAt) : 0;
    const tb = b.committedAt ? Date.parse(b.committedAt) : 0;
    return tb - ta;
  });

  return { commits };
}

export async function importCommits(input: {
  selections: CommitSelection[];
}): Promise<{ importedCount: number }> {
  const session = await requireSession();

  const result = await importSelectedCommits(
    { tenantId: session.user.tenantId, selections: input.selections },
    getCommitDiff
  );

  revalidatePath("/pending");
  return result;
}
