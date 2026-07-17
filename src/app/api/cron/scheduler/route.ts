import { NextRequest, NextResponse } from "next/server";
import { runSchedulerTick } from "@/lib/run-schedule";
import { retryFailedWebhookDeliveries } from "@/lib/publishing/webhook-delivery";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  await runSchedulerTick(new Date());
  await retryFailedWebhookDeliveries();

  return NextResponse.json({ ok: true });
}
