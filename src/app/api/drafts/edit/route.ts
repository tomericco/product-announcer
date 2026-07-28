import { getServerSession } from "next-auth";
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { authOptions } from "@/lib/workspace/auth";
import { hasValidSession } from "@/lib/workspace/session";
import { ACTIVE_TENANT_COOKIE, resolveActiveTenant } from "@/lib/workspace/active-tenant";
import { db } from "@/db";
import { releases } from "@/db/schema";
import { runWholeEditForRelease } from "@/lib/ai/edit-release";
import type { DraftProgressEvent } from "@/lib/scheduling/draft-progress";

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Streams a whole-update agent edit through the same generate → review → save
 * pipeline (and stepped progress) as the compose route. Fetch/ndjson API, so it
 * fails with a plain 401 rather than a redirect (see the compose route). The
 * release id is re-checked against the resolved tenant — never trusted from the
 * request body.
 */
export async function POST(req: Request): Promise<Response> {
  const session = await getServerSession(authOptions);
  if (!hasValidSession(session)) {
    return unauthorized();
  }
  const store = await cookies();
  const cookieTenantId = store.get(ACTIVE_TENANT_COOKIE)?.value;
  const active = await resolveActiveTenant(session.user.id, cookieTenantId);
  if (!active) {
    return unauthorized();
  }
  const tenantId = active.tenantId;
  const editedBy = session.user.id;

  const body = await req.json().catch(() => null);
  const releaseId = typeof body?.releaseId === "string" ? body.releaseId : "";
  const instruction = typeof body?.instruction === "string" ? body.instruction.trim() : "";
  const fullBody = typeof body?.fullBody === "string" ? body.fullBody : "";

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: DraftProgressEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        if (!releaseId || !instruction) {
          emit({ type: "error", message: "Missing an update to edit or an instruction." });
          return;
        }
        // Ownership + existence check against the resolved tenant, not the
        // client-supplied id.
        const [owned] = await db
          .select({ id: releases.id })
          .from(releases)
          .where(and(eq(releases.id, releaseId), eq(releases.tenantId, tenantId)));
        if (!owned) {
          emit({ type: "error", message: "Update not found for this tenant." });
          return;
        }
        await runWholeEditForRelease({ releaseId, instruction, fullBody, editedBy }, db, emit);
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
