import { requireSession } from "@/lib/workspace/session";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  bucketKeys,
  creditsByFeature,
  creditsByPeriod,
  monthToDateCredits,
  byokTokensByPeriod,
  byokTokensMonthToDate,
  type Granularity,
  type UsagePoint,
} from "@/lib/usage/queries";
import { getMonthlyCreditLimit } from "@/lib/usage/limit";
import { FEATURE_ORDER, type FeatureKey } from "@/lib/usage/features";
import { UsageHeadline } from "./usage-headline";
import { UsageChart, type UsageChartRow, type UsageDataset } from "./usage-chart";
import { ByokUsageChart } from "./byok-usage-chart";

/** Axis label for a bucket key: "Aug 28" (daily/weekly) or "Aug 2026" (monthly). */
function bucketLabel(granularity: Granularity, key: string): string {
  // Pinned locale + UTC, same reasoning as group-by-month.ts.
  if (granularity === "monthly") {
    const [year, month] = key.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  return new Date(`${key}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Zero-filled chart rows over the full bucket skeleton. */
function toRows(granularity: Granularity, points: UsagePoint[], now: Date): UsageChartRow[] {
  const rows = new Map<string, UsageChartRow>(
    bucketKeys(granularity, now).map((key) => [
      key,
      { bucket: key, label: bucketLabel(granularity, key) },
    ])
  );
  for (const point of points) {
    const row = rows.get(point.bucket);
    if (row) row[point.feature] = (row[point.feature] ?? 0) + point.credits;
  }
  return [...rows.values()];
}

export async function UsageSettings() {
  const session = await requireSession();
  const tenantId = session.user.tenantId;
  const now = new Date();

  const [credits, limit, byokMtd, byokMonthly] = await Promise.all([
    monthToDateCredits(tenantId, now),
    getMonthlyCreditLimit(tenantId),
    byokTokensMonthToDate(tenantId, now),
    byokTokensByPeriod(tenantId, "monthly", now),
  ]);

  const granularities: Granularity[] = ["daily", "weekly", "monthly"];
  const datasets = Object.fromEntries(
    await Promise.all(
      granularities.map(async (granularity) => {
        const [points, totals] = await Promise.all([
          creditsByPeriod(tenantId, granularity, now),
          creditsByFeature(tenantId, granularity, now),
        ]);
        return [granularity, { rows: toRows(granularity, points, now), totals }];
      })
    )
  ) as Record<Granularity, UsageDataset>;

  // Ordered, and only features that appear in any window — no dead legend rows.
  const present = new Set<FeatureKey>(
    granularities.flatMap((g) => datasets[g].totals.map((t) => t.feature))
  );
  const features = FEATURE_ORDER.filter((feature) => present.has(feature));

  return (
    <div className="space-y-8">
      <Card>
        <CardHeader>
          <CardTitle>AI credits</CardTitle>
        </CardHeader>
        <CardContent>
          <UsageHeadline credits={credits} limit={limit} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Usage over time</CardTitle>
        </CardHeader>
        <CardContent>
          <UsageChart datasets={datasets} features={features} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your own API keys (AI visibility sweeps)</CardTitle>
        </CardHeader>
        <CardContent>
          <ByokUsageChart monthToDate={byokMtd} points={byokMonthly} />
        </CardContent>
      </Card>
    </div>
  );
}
