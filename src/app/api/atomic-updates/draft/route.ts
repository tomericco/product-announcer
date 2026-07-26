import { getServerSession } from "next-auth";
import { cookies } from "next/headers";
import { authOptions } from "@/lib/workspace/auth";
import { hasValidSession } from "@/lib/workspace/session";
import { ACTIVE_TENANT_COOKIE, resolveActiveTenant } from "@/lib/workspace/active-tenant";
import { db } from "@/db";
import { getOpenAtomicUpdates } from "@/lib/change-events/release-claim";
import { runBatchForWorkspace } from "@/lib/scheduling/run-schedule";
import type { DraftProgressEvent } from "@/lib/scheduling/draft-progress";

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(req: Request): Promise<Response> {
  const session = await getServerSession(authOptions);
  if (!hasValidSession(session)) {
    return unauthorized();
  }
  // A JWT can outlive the tenant/membership row it points at (deleted
  // tenant, removed membership, restored backup). This is a fetch-based
  // JSON/ndjson API, not a browser-navigated page, so it must fail with a
  // plain 401 rather than requireSession()'s redirect (a fetch() caller
  // won't follow a redirect into a page render). Resolve the active tenant
  // the same way requireSession() does, from real membership rows.
  const store = await cookies();
  const cookieTenantId = store.get(ACTIVE_TENANT_COOKIE)?.value;
  const active = await resolveActiveTenant(session.user.id, cookieTenantId);
  if (!active) {
    return unauthorized();
  }
  const tenantId = active.tenantId;

  const body = await req.json().catch(() => null);
  const requestedIds: string[] = Array.isArray(body?.atomicUpdateIds)
    ? body.atomicUpdateIds.filter((id: unknown): id is string => typeof id === "string")
    : [];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: DraftProgressEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        emit({ type: "step", key: "collecting", status: "start" });
        // Re-derive the tenant's open atomic updates server-side and intersect
        // with the requested ids, rather than trusting the client's list
        // outright — this is the ownership + still-open check in one pass
        // (a stale or foreign id in the request is silently dropped, not an error).
        const open = await getOpenAtomicUpdates(tenantId, db);
        const requested = new Set(requestedIds);
        const selected = open.filter((a) => requested.has(a.id));
        if (selected.length === 0) {
          emit({ type: "error", message: "No selected atomic updates are available to draft." });
          return;
        }
        emit({ type: "step", key: "collecting", status: "done" });
        await runBatchForWorkspace(tenantId, selected, db, emit);
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
