import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { repos } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { applyPostRunScheduleChoice } from "@/lib/run-schedule";

export async function POST(request: NextRequest, { params }: { params: Promise<{ repoId: string }> }) {
  const session = await requireSession();
  const { repoId } = await params;
  const body = (await request.json()) as { choice: "keep" | "skip" };

  const [repo] = await db.select().from(repos).where(eq(repos.id, repoId)).limit(1);
  if (!repo || repo.tenantId !== session.user.tenantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  await applyPostRunScheduleChoice(repoId, body.choice);

  return NextResponse.json({ ok: true });
}
