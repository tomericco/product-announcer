"use server";

// This file currently handles commit import only. It's the seam for future
// import sources (PRs, Notion tasks) — new sources get their own
// list/import actions here (or alongside), fanning into the same
// `ImportDialog` UI.

import { and, eq, inArray, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { changeEvents, repos } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getCommitDiff, listRepoCommits, listRepoPullRequests } from "@/lib/integrations/github/github";
import { importSelectedCommits, type CommitSelection } from "@/lib/change-events/import-commits";
import { importSelectedPullRequests, type PullRequestSelection } from "@/lib/change-events/import-pull-requests";

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
            .select({ sha: changeEvents.commitSha })
            .from(changeEvents)
            .where(
              and(
                eq(changeEvents.repoId, repo.id),
                inArray(changeEvents.commitSha, shas),
                ne(changeEvents.status, "excluded")
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

  // Imported commits can resolve straight into atomic updates, and the
  // trigger now lives on /change-events — revalidate both surfaces.
  revalidatePath("/atomic-updates");
  revalidatePath("/change-events");
  return result;
}

export type ImportablePullRequest = {
  repoId: string;
  repoFullName: string;
  number: number;
  title: string;
  body: string | null;
  url: string;
  mergedAt: string | null;
  authorName: string | null;
  imported: boolean;
};

export async function listImportablePullRequests(input: {
  repoIds: string[];
  since?: string;
  until?: string;
}): Promise<{ pullRequests: ImportablePullRequest[] }> {
  const session = await requireSession();
  if (input.repoIds.length === 0) return { pullRequests: [] };

  const ownedRepos = await db
    .select()
    .from(repos)
    .where(and(eq(repos.tenantId, session.user.tenantId), inArray(repos.id, input.repoIds)));

  const perRepo = await Promise.all(
    ownedRepos.map(async (repo) => {
      let prs;
      try {
        prs = await listRepoPullRequests(repo.githubInstallationId, repo.githubRepoFullName, repo.watchedBranch, {
          since: input.since,
          until: input.until,
        });
      } catch {
        return [] as ImportablePullRequest[];
      }
      const numbers = prs.map((p) => p.number);
      const existing = numbers.length
        ? await db
            .select({ number: changeEvents.prNumber })
            .from(changeEvents)
            .where(
              and(
                eq(changeEvents.repoId, repo.id),
                inArray(changeEvents.prNumber, numbers),
                ne(changeEvents.status, "excluded")
              )
            )
        : [];
      const importedNumbers = new Set(existing.map((e) => e.number));
      return prs.map((p) => ({
        repoId: repo.id,
        repoFullName: repo.githubRepoFullName,
        number: p.number,
        title: p.title,
        body: p.body,
        url: p.url,
        mergedAt: p.mergedAt,
        authorName: p.authorName,
        imported: importedNumbers.has(p.number),
      }));
    })
  );

  const pullRequests = perRepo.flat().sort((a, b) => {
    const ta = a.mergedAt ? Date.parse(a.mergedAt) : 0;
    const tb = b.mergedAt ? Date.parse(b.mergedAt) : 0;
    return tb - ta;
  });
  return { pullRequests };
}

export async function importPullRequests(input: {
  selections: PullRequestSelection[];
}): Promise<{ importedCount: number }> {
  const session = await requireSession();
  const result = await importSelectedPullRequests({ tenantId: session.user.tenantId, selections: input.selections });
  revalidatePath("/atomic-updates");
  revalidatePath("/change-events");
  return result;
}
