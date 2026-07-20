import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { repos, changeItems } from "@/db/schema";
import {
  truncateDiff,
  getCommitDiff,
  listPushCommits,
  getCommitPulls,
  type PushCommit,
} from "@/lib/integrations/github/github";
import { mapWithConcurrency } from "@/lib/concurrency";
import { enrichChangeItem, type EnrichChangeItem, type EnrichmentResult } from "@/lib/ai/enrich-change-item";

const ENRICH_CONCURRENCY = 5;

export type PushInput = {
  installationId: string;
  repoFullName: string;
  ref: string;
  before: string;
  after: string;
  payloadCommits: Array<{ id: string; message: string; url: string; timestamp: string }>;
};

export type IngestPushDeps = {
  listPushCommits?: typeof listPushCommits;
  getCommitPulls?: typeof getCommitPulls;
  getCommitDiff?: typeof getCommitDiff;
  enrich?: EnrichChangeItem;
  database?: typeof defaultDb;
};

type RepoRow = typeof repos.$inferSelect;

async function insertCommit(
  database: typeof defaultDb,
  repo: RepoRow,
  commit: PushCommit,
  opts: {
    status: "pending" | "ignored";
    ignoredReason: "merge_commit" | "empty_diff" | null;
    diff: string | null;
    enrichment: EnrichmentResult | null;
  }
): Promise<void> {
  await database
    .insert(changeItems)
    .values({
      tenantId: repo.tenantId,
      repoId: repo.id,
      sourceType: "commit",
      status: opts.status,
      ignoredReason: opts.ignoredReason,
      commitSha: commit.sha,
      commitMessage: commit.message,
      commitUrl: commit.url,
      committedAt: commit.committedAt ? new Date(commit.committedAt) : null,
      diff: opts.diff,
      userFacing: opts.enrichment?.userFacing ?? null,
      impactSummary: opts.enrichment?.impactSummary ?? null,
      suggestedCategory: opts.enrichment?.suggestedCategory ?? null,
      enrichmentConfidence: opts.enrichment?.confidence ?? null,
      enrichedAt: opts.enrichment ? new Date() : null,
    })
    .onConflictDoNothing();
}

export async function ingestPush(input: PushInput, deps: IngestPushDeps = {}): Promise<void> {
  const listCommits = deps.listPushCommits ?? listPushCommits;
  const commitPulls = deps.getCommitPulls ?? getCommitPulls;
  const commitDiff = deps.getCommitDiff ?? getCommitDiff;
  const enrich = deps.enrich ?? enrichChangeItem;
  const database = deps.database ?? defaultDb;

  const [repo] = await database
    .select()
    .from(repos)
    .where(and(eq(repos.githubInstallationId, input.installationId), eq(repos.githubRepoFullName, input.repoFullName)))
    .limit(1);
  if (!repo) return;
  if (input.ref !== `refs/heads/${repo.watchedBranch}`) return;

  const commits = await listCommits(input.installationId, input.repoFullName, {
    before: input.before,
    after: input.after,
    payloadCommits: input.payloadCommits,
  });

  await mapWithConcurrency(commits, ENRICH_CONCURRENCY, async (commit) => {
    try {
      // 1. Belongs to a PR merged into the watched branch → drop (the PR is its own
      // rich item). A PR merged into a different branch (e.g. GitFlow promotion
      // commits whose PR targeted `develop`, later fast-forwarded/merged onto
      // `main`) must NOT be dropped here — it has no corresponding PR item on the
      // watched branch, so it falls through to classification like a direct commit.
      const pulls = await commitPulls(input.installationId, input.repoFullName, commit.sha);
      if (pulls.some((p) => p.merged && p.baseRef === repo.watchedBranch)) return;

      // 2. Merge commit with no associated PR → ignored (no diff, no enrichment).
      if (commit.parents.length >= 2) {
        await insertCommit(database, repo, commit, { status: "ignored", ignoredReason: "merge_commit", diff: null, enrichment: null });
        return;
      }

      // 3. Empty diff → ignored (no enrichment).
      const diff = truncateDiff(await commitDiff(input.installationId, input.repoFullName, commit.sha));
      if (diff.trim() === "") {
        await insertCommit(database, repo, commit, { status: "ignored", ignoredReason: "empty_diff", diff, enrichment: null });
        return;
      }

      // 4. Substantive → enrich + pending.
      const enrichment = await enrich({ tenantId: repo.tenantId, sourceType: "commit", repoName: input.repoFullName, commitMessage: commit.message, diff });
      await insertCommit(database, repo, commit, { status: "pending", ignoredReason: null, diff, enrichment });
    } catch (error) {
      // One bad commit (flaky API call, transient error) must not abort the whole
      // push via `Promise.all` inside `mapWithConcurrency` and abandon the
      // untouched tail — log and move on, the rest of the push still ingests.
      console.error(`[ingest-push] failed commit ${commit.sha} in ${input.repoFullName}:`, error);
    }
  });
}
