import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { repos, scheduleConfigs } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { getPendingChangeItems } from "@/lib/change-item-batch";
import { runBatchForRepo } from "@/lib/run-schedule";

export async function POST(request: NextRequest, { params }: { params: Promise<{ repoId: string }> }) {
  const session = await requireSession();
  const { repoId } = await params;

  const [repo] = await db.select().from(repos).where(eq(repos.id, repoId)).limit(1);
  if (!repo || repo.tenantId !== session.user.tenantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const pending = await getPendingChangeItems(repoId);
  if (pending.length === 0) {
    return NextResponse.json({ error: "nothing pending" }, { status: 400 });
  }

  await runBatchForRepo(repoId, repo.tenantId, pending);
  await db.update(scheduleConfigs).set({ lastRunAt: new Date() }).where(eq(scheduleConfigs.repoId, repoId));

  return NextResponse.json({ ok: true });
}
