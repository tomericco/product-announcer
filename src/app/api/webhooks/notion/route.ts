import { NextRequest, NextResponse, after } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { notionConnections } from "@/db/schema";
import { verifyNotionSignature, parseVerificationHandshake } from "@/lib/integrations/notion/notion-webhook";
import { withFreshToken } from "@/lib/integrations/notion/connection";
import { getPage } from "@/lib/integrations/notion/client";
import { ingestNotionTask } from "@/lib/change-events/ingest-notion-task";

type NotionEvent = {
  type?: string;
  workspace_id?: string;
  entity?: { id?: string };
  data?: { updated_properties?: string[] };
  timestamp?: string;
};

// Steps 4-9 of the spec. Exported for direct testing; the route runs it inside
// after() so the webhook response is never blocked on Notion API round-trips.
export async function processNotionEvent(payload: NotionEvent): Promise<void> {
  const workspaceId = payload.workspace_id;
  const pageId = payload.entity?.id;
  if (!workspaceId || !pageId) return;

  // Step 4: route to a tenant by workspace_id. Unknown workspace → drop.
  const [connection] = await db
    .select()
    .from(notionConnections)
    .where(eq(notionConnections.workspaceId, workspaceId))
    .limit(1);
  if (!connection || connection.status !== "active" || !connection.statusPropertyId) return;

  // Step 5: cheap rejection — most property edits are not status changes.
  const updated = payload.data?.updated_properties ?? [];
  if (!updated.includes(connection.statusPropertyId)) return;

  // Step 6: read current property values (refreshing the token on a 401).
  const page = await withFreshToken(db, connection, (token) => getPage(token, pageId));

  // Step 7: only ingest when the status value means "done".
  const statusValue = page.statusByPropertyId[connection.statusPropertyId];
  if (!statusValue || !connection.doneValues.includes(statusValue)) return;

  // Steps 8-9: hand off to the shared ingestion pipeline. Out-of-order-safe:
  // use the payload timestamp for completedAt, not arrival time.
  const completedAt = payload.timestamp ? new Date(payload.timestamp) : new Date();
  await ingestNotionTask({
    tenantId: connection.tenantId,
    pageId,
    title: page.title,
    description: page.description || null,
    url: page.url,
    completedAt,
  });
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  // Step 2: the one-time verification handshake is not a signed event. Log the
  // token so it can be copied into NOTION_WEBHOOK_VERIFICATION_TOKEN, then 200.
  const handshakeToken = parseVerificationHandshake(rawBody);
  if (handshakeToken) {
    console.log("[notion-webhook] verification_token:", handshakeToken);
    return NextResponse.json({ ok: true });
  }

  // Step 1: verify the signature over the raw body before doing any work.
  if (!verifyNotionSignature(rawBody, request.headers.get("x-notion-signature"))) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: NotionEvent;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: true });
  }

  // Step 3: only page.properties_updated is relevant.
  if (payload.type !== "page.properties_updated") {
    return NextResponse.json({ ok: true });
  }

  after(async () => {
    try {
      await processNotionEvent(payload);
    } catch (error) {
      console.error("Deferred Notion event processing failed:", error);
    }
  });

  return NextResponse.json({ ok: true });
}
