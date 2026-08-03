import { NextRequest, NextResponse } from "next/server";
import { retryFailedDeliveries } from "@/lib/publishing/dispatch";
import { sweepUnresolvedEvents } from "@/lib/change-events/resolve-sweep";
import { syncShippedWorkSignals } from "@/lib/signals/shipped-work";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // The cadence scheduler was retired with the content hub pivot — auto-composing
  // drafts is autopilot, and the model is human-gated. Spec 3 adds the source-agent
  // sweep here and spec 5 adds the ideation run. Delivery retries and event
  // resolution are unrelated to cadence and keep running meanwhile.
  await retryFailedDeliveries();
  await sweepUnresolvedEvents();
  // Must run after the sweep above: that sweep can create atomic updates on
  // this same run, and the reconciler needs to see them.
  await syncShippedWorkSignals();

  return NextResponse.json({ ok: true });
}
