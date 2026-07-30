import { getServerSession } from "next-auth";
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { authOptions } from "@/lib/workspace/auth";
import { hasValidSession } from "@/lib/workspace/session";
import { ACTIVE_TENANT_COOKIE, resolveActiveTenant } from "@/lib/workspace/active-tenant";
import { db } from "@/db";
import { releases } from "@/db/schema";
import { notEditableMessage } from "@/lib/draft-editable";
import { runExtractForRelease } from "@/lib/ai/extract-release";
import type { DraftProgressEvent } from "@/lib/scheduling/draft-progress";

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Splits a highlighted passage out of a draft into a new draft, streaming the
 * same stepped progress as the compose and whole-edit routes. Fetch/ndjson API,
 * so it fails with a plain 401 rather than a redirect (see the compose route).
 * The release id is re-checked against the resolved tenant — never trusted from
 * the request body.
 *
 * `remainingBody` is supplied by the client because only the editor knows the
 * selection's structure; see `runExtractForRelease` for why it isn't derived
 * server-side.
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
  const excerpt = typeof body?.excerpt === "string" ? body.excerpt : "";
  const remainingBody = typeof body?.remainingBody === "string" ? body.remainingBody : "";
  const instruction = typeof body?.instruction === "string" ? body.instruction.trim() : "";

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: DraftProgressEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        if (!releaseId || excerpt.trim().length === 0) {
          emit({ type: "error", message: "Missing an update to split or a passage to extract." });
          return;
        }
        // Server-side repeat of the client's guard, for a crafted request.
        if (remainingBody.trim().length === 0) {
          emit({
            type: "error",
            message: "You can't extract the entire update — leave some text behind.",
          });
          return;
        }
        // Ownership + existence check against the resolved tenant, not the
        // client-supplied id. `status` comes back too so a release that has
        // left the draft state is refused here, before the pipeline runs —
        // splitting a published release would rewrite text already delivered.
        const [owned] = await db
          .select({ id: releases.id, status: releases.status })
          .from(releases)
          .where(and(eq(releases.id, releaseId), eq(releases.tenantId, tenantId)));
        if (!owned) {
          emit({ type: "error", message: "Update not found for this tenant." });
          return;
        }
        if (owned.status !== "draft") {
          emit({ type: "error", message: notEditableMessage(owned.status) });
          return;
        }
        await runExtractForRelease(
          { releaseId, excerpt, remainingBody, instruction, editedBy },
          db,
          emit
        );
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
