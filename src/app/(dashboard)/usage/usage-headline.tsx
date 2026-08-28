/**
 * Month-to-date credits, and — the limit seam's UI half — progress against a
 * monthly limit when `getMonthlyCreditLimit` starts returning one. `null`
 * limit renders a plain total with NO mention of limits: today every tenant
 * is unlimited and the UI must not imply otherwise.
 *
 * Numbers via a pinned locale ("en-US") like `group-by-month.ts` — a
 * server/client locale mismatch here is a hydration error.
 */
const formatter = new Intl.NumberFormat("en-US");

export function UsageHeadline({ credits, limit }: { credits: number; limit: number | null }) {
  if (limit === null) {
    return (
      <div className="space-y-1">
        <p className="text-2xl font-semibold">{formatter.format(credits)} credits</p>
        <p className="text-sm text-muted-foreground">used this month (1 credit = 1 token)</p>
      </div>
    );
  }
  const pct = Math.min(100, Math.round((credits / limit) * 100));
  return (
    <div className="space-y-2">
      <p className="text-2xl font-semibold">
        {formatter.format(credits)} of {formatter.format(limit)} credits
      </p>
      <div
        role="progressbar"
        aria-valuenow={credits}
        aria-valuemin={0}
        aria-valuemax={limit}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-sm text-muted-foreground">used this month (1 credit = 1 token)</p>
    </div>
  );
}
