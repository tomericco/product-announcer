import { NextRequest, NextResponse } from "next/server";
import { runSchedulerTick } from "@/lib/scheduling/run-schedule";
import { retryFailedDeliveries } from "@/lib/publishing/dispatch";
import { sweepUnresolvedEvents } from "@/lib/change-events/resolve-sweep";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  await runSchedulerTick(new Date());
  await retryFailedDeliveries();
  await sweepUnresolvedEvents();

  return NextResponse.json({ ok: true });
}
