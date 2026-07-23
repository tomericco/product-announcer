import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { repos, changeEvents } from "@/db/schema";
import {
  truncateDiff,
  getCommitDiff,
  listPushCommits,
  getCommitPulls,
  type PushCommit,
} from "@/lib/integrations/github/github";
import { mapWithConcurrency } from "@/lib/concurrency";
import { enrichChangeItem, type EnrichChangeItem, type EnrichmentResult } from "@/lib/ai/enrich-change-item";
import { filterCommit, type FilterReason } from "@/lib/change-events/filter";
import { resolvePendingEvents } from "@/lib/change-events/pipeline";

const ENRICH_CONCURRENCY = 5;

export type PushInput = {
  installationId: string;
  repoFullName: string;
  ref: string;
  before: string;
  after: string;
  /**
   * When this push landed on the branch. Captured at the webhook route, not
   * here — ingestion is deferred behind enrichment and would read late.
   */
  pushedAt: Date;
  payloadCommits: Array<{ id: string; message: string; url: string; timestamp: string }>;
};

export type IngestPushDeps = {
  listPushCommits?: typeof listPushCommits;
  getCommitPulls?: typeof getCommitPulls;
  getCommitDiff?: typeof getCommitDiff;
  enrich?: EnrichChangeItem;
  resolvePending?: typeof resolvePendingEvents;
  database?: typeof defaultDb;
};

type RepoRow = typeof repos.$inferSelect;

async function insertCommit(
  database: typeof defaultDb,
  repo: RepoRow,
  commit: PushCommit,
  opts: {
    status: "pending" | "ignored";
    filterReason: FilterReason | null;
    diff: string | null;
    enrichment: EnrichmentResult | null;
    releasedAt: Date;
  }
): Promise<string | null> {
  const [row] = await database
    .insert(changeEvents)
    .values({
      tenantId: repo.tenantId,
      repoId: repo.id,
      type: "commit",
      provider: "github",
      externalId: commit.sha,
      externalUrl: commit.url,
      status: opts.status,
      filterReason: opts.filterReason,
      commitSha: commit.sha,
      commitMessage: commit.message,
      commitUrl: commit.url,
      committedAt: commit.committedAt ? new Date(commit.committedAt) : null,
      releasedAt: opts.releasedAt,
      diff: opts.diff,
      userFacing: opts.enrichment?.userFacing ?? null,
      impactSummary: opts.enrichment?.impactSummary ?? null,
      suggestedCategory: opts.enrichment?.suggestedCategory ?? null,
      enrichmentConfidence: opts.enrichment?.confidence ?? null,
      enrichedAt: opts.enrichment ? new Date() : null,
    })
    .onConflictDoNothing()
    .returning({ id: changeEvents.id });

  return row?.id ?? null;
}

export async function ingestPush(input: PushInput, deps: IngestPushDeps = {}): Promise<void> {
  const listCommits = deps.listPushCommits ?? listPushCommits;
  const commitPulls = deps.getCommitPulls ?? getCommitPulls;
  const commitDiff = deps.getCommitDiff ?? getCommitDiff;
  const enrich = deps.enrich ?? enrichChangeItem;
  const resolvePending = deps.resolvePending ?? resolvePendingEvents;
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

  // Tiers 1 and 2 run per commit, in parallel. Only tier 3 needs the batch.
  const resolvable = await mapWithConcurrency(commits, ENRICH_CONCURRENCY, async (commit) => {
    try {
      // Belongs to a PR merged into the watched branch → drop (the PR is its own
      // rich item). A PR merged into a different branch (e.g. GitFlow promotion
      // commits whose PR targeted `develop`, later fast-forwarded/merged onto
      // `main`) must NOT be dropped here — it has no corresponding PR item on the
      // watched branch, so it falls through to classification like a direct commit.
      const pulls = await commitPulls(input.installationId, input.repoFullName, commit.sha);
      if (pulls.some((p) => p.merged && p.baseRef === repo.watchedBranch)) return null;

      // A merge commit has no diff to fetch, so decide on parent count first and
      // avoid the API call entirely.
      const preDiff = filterCommit({ message: commit.message, diff: "x", parentCount: commit.parents.length });
      if (preDiff.drop && preDiff.reason === "merge_commit") {
        await insertCommit(database, repo, commit, {
          status: "ignored",
          filterReason: "merge_commit",
          diff: null,
          enrichment: null,
          releasedAt: input.pushedAt,
        });
        return null;
      }

      // Tier 1 proper, now with the diff in hand.
      const diff = truncateDiff(await commitDiff(input.installationId, input.repoFullName, commit.sha));
      const verdict = filterCommit({
        message: commit.message,
        diff,
        parentCount: commit.parents.length,
      });
      if (verdict.drop) {
        await insertCommit(database, repo, commit, {
          status: "ignored",
          filterReason: verdict.reason,
          diff,
          enrichment: null,
          releasedAt: input.pushedAt,
        });
        return null;
      }

      // Tier 2.
      const enrichment = await enrich({
        tenantId: repo.tenantId,
        type: "commit",
        repoName: input.repoFullName,
        commitMessage: commit.message,
        diff,
      });
      const id = await insertCommit(database, repo, commit, {
        status: "pending",
        filterReason: null,
        diff,
        enrichment,
        releasedAt: input.pushedAt,
      });

      return enrichment.userFacing ? id : null;
    } catch (error) {
      // One bad commit (flaky API call, transient error) must not abort the whole
      // push via `Promise.all` inside `mapWithConcurrency` and abandon the
      // untouched tail — log and move on, the rest of the push still ingests.
      console.error(`[ingest-push] failed commit ${commit.sha} in ${input.repoFullName}:`, error);
      return null;
    }
  });

  // Tier 3: one batch for the whole push, so commits that belong together are
  // grouped in a single decision rather than one at a time.
  const eventIds = resolvable.filter((id): id is string => id !== null);
  if (eventIds.length > 0) await resolvePending(repo.tenantId, eventIds);
}
