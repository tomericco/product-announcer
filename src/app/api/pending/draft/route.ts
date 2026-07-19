import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/workspace/auth";
import { hasValidSession } from "@/lib/workspace/session";
import { db } from "@/db";
import { getBatchableChangeItems } from "@/lib/change-items/change-item-batch";
import { runBatchForWorkspace } from "@/lib/scheduling/run-schedule";
import type { DraftProgressEvent } from "@/lib/scheduling/draft-progress";

export async function POST(_req: Request): Promise<Response> {
  const session = await getServerSession(authOptions);
  if (!hasValidSession(session)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const tenantId = session.user.tenantId;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: DraftProgressEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        emit({ type: "step", key: "collecting", status: "start" });
        const pending = await getBatchableChangeItems(tenantId, db);
        if (pending.length === 0) {
          emit({ type: "error", message: "No pending changes to draft." });
          return;
        }
        emit({ type: "step", key: "collecting", status: "done" });
        await runBatchForWorkspace(tenantId, pending, db, emit);
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
