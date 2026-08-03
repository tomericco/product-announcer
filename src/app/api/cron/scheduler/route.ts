import { NextResponse } from "next/server";

/**
 * The cadence scheduler was retired with the content hub pivot — auto-composing
 * drafts is autopilot, and the model is human-gated. Spec 3 replaces this body
 * with the source-agent sweep and spec 5 adds the ideation run.
 */
export async function GET() {
  return NextResponse.json({ ok: true, ran: [] });
}
