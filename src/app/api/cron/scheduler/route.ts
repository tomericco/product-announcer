import { NextRequest, NextResponse } from "next/server";
import { retryFailedDeliveries } from "@/lib/publishing/dispatch";
import { sweepUnresolvedEvents } from "@/lib/change-events/resolve-sweep";
import { syncShippedWorkSignals } from "@/lib/signals/shipped-work";
import { sweepCompetitorSources } from "@/lib/signals/sweep";
import { sweepNewsSources } from "@/lib/signals/news-sweep";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // The cadence scheduler was retired with the content hub pivot — auto-composing
  // drafts is autopilot, and the model is human-gated. Spec 5 adds the ideation
  // run. Delivery retries and event resolution are unrelated to cadence and keep
  // running meanwhile.
  await retryFailedDeliveries();
  await sweepUnresolvedEvents();
  // Must run after the sweep above: that sweep can create atomic updates on
  // this same run, and the reconciler needs to see them.
  await syncShippedWorkSignals();
  // Runs after the shipped-work reconcile so a single cron run leaves the
  // signals table consistent before the competitor agent adds to it.
  await sweepCompetitorSources();
  // Runs after the competitor sweep for the same reason that one runs after
  // the shipped-work reconcile: each producer sees a signals table the
  // previous one has finished with. Both are per-source isolated, so a
  // failure in either leaves the other's work intact.
  await sweepNewsSources();

  return NextResponse.json({ ok: true });
}
