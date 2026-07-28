"use server";

// This file currently handles commit import only. It's the seam for future
// import sources (PRs, Notion tasks) — new sources get their own
// list/import actions here (or alongside), fanning into the same
// `ImportDialog` UI.

import { and, eq, inArray, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { changeEvents, repos, notionConnections } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getCommitDiff, listRepoCommits, listRepoPullRequests } from "@/lib/integrations/github/github";
import { withFreshToken } from "@/lib/integrations/notion/connection";
import { resolveDataSourceId, listDoneTasks, getPageBodyText } from "@/lib/integrations/notion/client";
import { importSelectedCommits, type CommitSelection } from "@/lib/change-events/import-commits";
import { importSelectedPullRequests, type PullRequestSelection } from "@/lib/change-events/import-pull-requests";
import { importSelectedTasks } from "@/lib/change-events/import-notion-tasks";
import {
  createAtomicUpdateFromImportedCommits,
  createAtomicUpdateFromImportedPullRequests,
  createAtomicUpdateFromImportedTasks,
  addImportedTasksToAtomicUpdate,
  addImportedCommitsToAtomicUpdate,
  addImportedPullRequestsToAtomicUpdate,
} from "@/lib/change-events/create-from-import";
import type { CreateFromEventsResult } from "@/lib/change-events/create-from-events";
import type { AddEventsResult } from "@/lib/change-events/add-events-to-atomic-update";

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

// The "New atomic update" modal reuses the import selector but its CTA groups
// the selected events into ONE new atomic update instead of just importing
// them. Tenant/user come from the session, never the input.
export async function createAtomicUpdateFromCommits(input: {
  selections: CommitSelection[];
}): Promise<CreateFromEventsResult> {
  const session = await requireSession();
  const result = await createAtomicUpdateFromImportedCommits({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    selections: input.selections,
  });
  revalidatePath("/atomic-updates");
  revalidatePath("/change-events");
  return result;
}

export async function createAtomicUpdateFromPullRequests(input: {
  selections: PullRequestSelection[];
}): Promise<CreateFromEventsResult> {
  const session = await requireSession();
  const result = await createAtomicUpdateFromImportedPullRequests({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    selections: input.selections,
  });
  revalidatePath("/atomic-updates");
  revalidatePath("/change-events");
  return result;
}

export async function createAtomicUpdateFromTasks(input: {
  selections: TaskSelection[];
}): Promise<CreateFromEventsResult> {
  const session = await requireSession();
  const conn = await activeNotionConnection(session.user.tenantId);
  // A Notion-only workspace reaches this with no connection only if it was
  // disconnected between render and submit. Fail with the same shape the other
  // create actions use rather than throwing at the dialog.
  if (!conn) return { ok: false, reason: "Notion isn't connected." };

  const getBody = (pageId: string) => withFreshToken(db, conn, (token) => getPageBodyText(token, pageId));
  const result = await createAtomicUpdateFromImportedTasks(
    { tenantId: session.user.tenantId, userId: session.user.id, selections: input.selections },
    getBody
  );
  revalidatePath("/atomic-updates");
  revalidatePath("/change-events");
  return result;
}

// The per-card "Add change events" modal reuses the import selector; its CTA
// imports the selected events and adds them as evidence to an EXISTING atomic
// update (regenerating its summary). Tenant/user come from the session.
export async function addCommitsToAtomicUpdate(input: {
  atomicUpdateId: string;
  selections: CommitSelection[];
}): Promise<AddEventsResult> {
  const session = await requireSession();
  const result = await addImportedCommitsToAtomicUpdate({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    atomicUpdateId: input.atomicUpdateId,
    selections: input.selections,
  });
  revalidatePath("/atomic-updates");
  revalidatePath("/change-events");
  return result;
}

export async function addPullRequestsToAtomicUpdate(input: {
  atomicUpdateId: string;
  selections: PullRequestSelection[];
}): Promise<AddEventsResult> {
  const session = await requireSession();
  const result = await addImportedPullRequestsToAtomicUpdate({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    atomicUpdateId: input.atomicUpdateId,
    selections: input.selections,
  });
  revalidatePath("/atomic-updates");
  revalidatePath("/change-events");
  return result;
}

export async function addTasksToAtomicUpdate(input: {
  atomicUpdateId: string;
  selections: TaskSelection[];
}): Promise<AddEventsResult> {
  const session = await requireSession();
  const conn = await activeNotionConnection(session.user.tenantId);
  if (!conn) return { ok: false, reason: "Notion isn't connected." };

  const getBody = (pageId: string) => withFreshToken(db, conn, (token) => getPageBodyText(token, pageId));
  const result = await addImportedTasksToAtomicUpdate(
    {
      tenantId: session.user.tenantId,
      userId: session.user.id,
      atomicUpdateId: input.atomicUpdateId,
      selections: input.selections,
    },
    getBody
  );
  revalidatePath("/atomic-updates");
  revalidatePath("/change-events");
  return result;
}

export type ImportableTask = {
  pageId: string;
  title: string;
  url: string;
  completedAt: string | null; // last_edited_time proxy
  status: string | null;
  imported: boolean;
};

export type TaskSelection = {
  pageId: string;
  title: string;
  url: string;
  completedAt: string | null;
};

async function activeNotionConnection(tenantId: string) {
  const [conn] = await db
    .select()
    .from(notionConnections)
    .where(and(eq(notionConnections.tenantId, tenantId), eq(notionConnections.status, "active")))
    .limit(1);
  return conn ?? null;
}

export async function isNotionConnected(): Promise<boolean> {
  const session = await requireSession();
  return (await activeNotionConnection(session.user.tenantId)) !== null;
}

export async function listImportableTasks(input: {
  since?: string;
  until?: string;
}): Promise<{ tasks: ImportableTask[] }> {
  const session = await requireSession();
  const conn = await activeNotionConnection(session.user.tenantId);
  if (!conn || !conn.databaseId || !conn.statusPropertyName || conn.doneValues.length === 0) {
    return { tasks: [] };
  }

  // A Notion API failure here throws; the dialog's load() catches it and shows
  // "Couldn't load tasks." No active connection is NOT an error — it returns [].
  const summaries = await withFreshToken(db, conn, async (token) => {
    const dataSourceId = await resolveDataSourceId(token, conn.databaseId!);
    return listDoneTasks(token, dataSourceId, conn.statusPropertyName!, conn.doneValues);
  });

  const since = input.since ? Date.parse(input.since) : null;
  const until = input.until ? Date.parse(input.until) : null;
  const filtered = summaries.filter((t) => {
    if (!t.lastEditedTime) return true; // keep undated
    const ts = Date.parse(t.lastEditedTime);
    if (since !== null && ts < since) return false;
    if (until !== null && ts > until) return false;
    return true;
  });

  const pageIds = filtered.map((t) => t.pageId);
  const existing = pageIds.length
    ? await db
        .select({ externalId: changeEvents.externalId })
        .from(changeEvents)
        .where(
          and(
            eq(changeEvents.tenantId, session.user.tenantId),
            eq(changeEvents.provider, "notion"),
            inArray(changeEvents.externalId, pageIds),
            ne(changeEvents.status, "excluded")
          )
        )
    : [];
  const importedIds = new Set(existing.map((e) => e.externalId));

  const tasks = filtered.map((t) => ({
    pageId: t.pageId,
    title: t.title,
    url: t.url,
    completedAt: t.lastEditedTime,
    status: t.status,
    imported: importedIds.has(t.pageId),
  }));
  return { tasks };
}

export async function importTasks(input: {
  selections: TaskSelection[];
}): Promise<{ importedCount: number }> {
  const session = await requireSession();
  const conn = await activeNotionConnection(session.user.tenantId);
  if (!conn) return { importedCount: 0 };

  const getBody = (pageId: string) => withFreshToken(db, conn, (token) => getPageBodyText(token, pageId));
  const { importedCount } = await importSelectedTasks(
    { tenantId: session.user.tenantId, selections: input.selections },
    getBody
  );

  revalidatePath("/change-events");
  revalidatePath("/atomic-updates");
  return { importedCount };
}
