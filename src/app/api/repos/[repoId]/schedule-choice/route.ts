import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { repos, scheduleConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { advanceNextScheduledAt, type Cadence } from "@/lib/scheduler-decision";

export async function POST(request: NextRequest, { params }: { params: Promise<{ repoId: string }> }) {
  const session = await requireSession();
  const { repoId } = await params;
  const body = (await request.json()) as { choice: "keep" | "skip" };

  const [repo] = await db.select().from(repos).where(eq(repos.id, repoId)).limit(1);
  if (!repo || repo.tenantId !== session.user.tenantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (body.choice === "skip") {
    const [config] = await db.select().from(scheduleConfigs).where(eq(scheduleConfigs.repoId, repoId)).limit(1);
    if (config && config.cadence !== "none" && config.nextScheduledAt) {
      await db
        .update(scheduleConfigs)
        .set({
          nextScheduledAt: advanceNextScheduledAt(
            config.nextScheduledAt,
            config.cadence as Exclude<Cadence, "none">
          ),
        })
        .where(eq(scheduleConfigs.id, config.id));
    }
  }

  return NextResponse.json({ ok: true });
}
