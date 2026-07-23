import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/workspace/auth";
import { hasValidSession, tenantExists } from "@/lib/workspace/session";
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
  const tenantId = session.user.tenantId;
  // A JWT can outlive the tenant row it points at (deleted tenant, restored
  // backup). This is a fetch-based JSON/ndjson API, not a browser-navigated
  // page, so it must fail with a plain 401 rather than requireSession()'s
  // redirect (a fetch() caller won't follow a redirect into a page render).
  if (!(await tenantExists(tenantId))) {
    return unauthorized();
  }

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
