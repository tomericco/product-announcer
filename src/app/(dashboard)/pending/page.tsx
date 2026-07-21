import { eq } from "drizzle-orm";
import Link from "next/link";
import { FolderGit2, Inbox, ArrowRight } from "lucide-react";
import { db } from "@/db";
import { repos, scheduleConfigs } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getBatchableChangeItems, getTrackedChangeItems } from "@/lib/change-events/change-item-batch";
import { formatScheduleDistance } from "@/lib/scheduling/format-schedule";
import {
  changeItemFacingState,
  changeItemReleasedAt,
  ignoredReasonLabel,
} from "@/lib/change-events/change-item-display";
import { dropChangeItem, includeChangeItem } from "./actions";
import { ImportCommitsDialog } from "./import-commits-dialog";
import { DraftUpdateDialog } from "./draft-update-dialog";
import { NextPublishTime } from "./next-publish-time";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  EmptyState,
  EmptyStateIcon,
  EmptyStateTitle,
  EmptyStateDescription,
  EmptyStateActions,
} from "@/components/ui/empty-state";

export default async function PendingPage() {
  const session = await requireSession();

  const tenantRepos = await db.select().from(repos).where(eq(repos.tenantId, session.user.tenantId));

  if (tenantRepos.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState>
          <EmptyStateIcon>
            <FolderGit2 />
          </EmptyStateIcon>
          <EmptyStateTitle>No repos connected yet</EmptyStateTitle>
          <EmptyStateDescription>
            Product Announcer collects merged PRs and pushed commits from the repos you watch.
            Connect one to start seeing changes here.
          </EmptyStateDescription>
          <EmptyStateActions>
            <Button render={<Link href="/settings" />}>
              Connect a repo
              <ArrowRight />
            </Button>
          </EmptyStateActions>
        </EmptyState>
      </div>
    );
  }

  const repoNameById = new Map(tenantRepos.map((r) => [r.id, r.githubRepoFullName]));
  const importRepos = tenantRepos.map((r) => ({
    id: r.id,
    fullName: r.githubRepoFullName,
    watchedBranch: r.watchedBranch,
  }));
  const [config] = await db
    .select()
    .from(scheduleConfigs)
    .where(eq(scheduleConfigs.tenantId, session.user.tenantId));
  const tracked = await getTrackedChangeItems(session.user.tenantId);
  // Show the oldest change first, by when it reached users; items without a
  // timestamp sort last.
  tracked.sort((a, b) => {
    const ta = changeItemReleasedAt(a)?.getTime() ?? Infinity;
    const tb = changeItemReleasedAt(b)?.getTime() ?? Infinity;
    return ta - tb;
  });
  const pendingCount = tracked.filter((t) => t.status === "pending").length;

  const batchable = await getBatchableChangeItems(session.user.tenantId);
  const batchableWhens = batchable
    .map(changeItemReleasedAt)
    .filter((d): d is Date => d instanceof Date)
    .sort((a, b) => a.getTime() - b.getTime());
  const draftPreview = {
    count: batchable.length,
    earliest: batchableWhens[0]?.toISOString() ?? null,
    latest: batchableWhens.at(-1)?.toISOString() ?? null,
  };

  const nextRelative = config?.nextScheduledAt ? formatScheduleDistance(config.nextScheduledAt) : null;
  const nextAbsolute = config?.nextScheduledAt ? config.nextScheduledAt.toLocaleString() : null;

  if (tracked.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState>
          <EmptyStateIcon>
            <Inbox />
          </EmptyStateIcon>
          <EmptyStateTitle>You&apos;re all caught up</EmptyStateTitle>
          <EmptyStateDescription>
            New merged PRs and pushed commits from your watched repos land here automatically. Next
            scheduled update:{" "}
            {nextRelative && nextAbsolute ? (
              <NextPublishTime relative={nextRelative} absolute={nextAbsolute} />
            ) : (
              "not scheduled"
            )}
            .
          </EmptyStateDescription>
          <EmptyStateActions>
            <ImportCommitsDialog repos={importRepos} />
            <Button variant="outline" render={<Link href="/settings" />}>
              Manage repos &amp; schedule
            </Button>
          </EmptyStateActions>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Pending changes</h1>
          <p className="text-sm text-muted-foreground">
            {pendingCount} change{pendingCount === 1 ? "" : "s"} waiting to be announced.
          </p>
        </div>
        <ImportCommitsDialog repos={importRepos} />
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Source</TableHead>
              <TableHead>Change</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>When</TableHead>
              <TableHead className="pr-4 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tracked.map((item) => {
              const isPr = item.type === "pull_request";
              const change = (isPr ? item.prTitle : item.commitMessage) ?? "—";
              const url = isPr ? item.prUrl : item.commitUrl;
              const when = changeItemReleasedAt(item);
              const facingState = changeItemFacingState(item);
              const isNonFacing = facingState === "non-facing";
              const isIgnored = item.status === "ignored";
              return (
                <TableRow key={item.id} className={isNonFacing || isIgnored ? "opacity-60" : undefined}>
                  <TableCell className="pl-4">
                    <Badge variant="outline">{repoNameById.get(item.repoId) ?? "unknown"}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="max-w-[22rem] truncate font-medium">
                      {url ? (
                        <a href={url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                          {change}
                        </a>
                      ) : (
                        change
                      )}
                    </div>
                    {isIgnored ? (
                      <Badge variant="outline" className="mt-1 text-muted-foreground">
                        Ignored · {ignoredReasonLabel(item.filterReason)}
                      </Badge>
                    ) : facingState === "non-facing" ? (
                      <Badge variant="outline" className="mt-1 text-muted-foreground">
                        Not user-facing
                      </Badge>
                    ) : facingState === "low-confidence" ? (
                      <Badge variant="outline" className="mt-1 text-muted-foreground">
                        Low confidence
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{isPr ? "PR" : "Commit"}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {when ? when.toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    {!isIgnored && (
                      <div className="flex items-center justify-end gap-1">
                        {isNonFacing && (
                          <form action={includeChangeItem}>
                            <input type="hidden" name="changeItemId" value={item.id} />
                            <Button type="submit" variant="ghost" size="sm">
                              Include
                            </Button>
                          </form>
                        )}
                        <form action={dropChangeItem}>
                          <input type="hidden" name="changeItemId" value={item.id} />
                          <Button type="submit" variant="ghost" size="sm" className="text-muted-foreground">
                            Drop
                          </Button>
                        </form>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter>
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={5} className="px-4">
                <div className="flex flex-wrap items-center justify-between gap-3 py-1">
                  <p className="text-sm font-normal text-muted-foreground">
                    Next update{" "}
                    {nextRelative && nextAbsolute ? (
                      <NextPublishTime relative={nextRelative} absolute={nextAbsolute} />
                    ) : (
                      <span className="font-medium text-foreground">not scheduled</span>
                    )}
                    {" · "}
                    {pendingCount} pending
                    {config?.thresholdEnabled && config?.threshold ? ` / ${config.threshold} threshold` : ""}
                  </p>
                  <DraftUpdateDialog preview={draftPreview} />
                </div>
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>
    </div>
  );
}
