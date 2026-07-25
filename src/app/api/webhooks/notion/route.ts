import { NextRequest, NextResponse, after } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { notionConnections } from "@/db/schema";
import { verifyNotionSignature, parseVerificationHandshake } from "@/lib/integrations/notion/notion-webhook";
import { withFreshToken } from "@/lib/integrations/notion/connection";
import { getPage, getPageBodyText } from "@/lib/integrations/notion/client";
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

  // Step 4: route by workspace_id. workspaceId is NOT unique — two tenants can
  // connect the same Notion workspace — so fan out to ALL matching connections
  // rather than picking one arbitrarily (which would silently drop the others).
  const connections = await db
    .select()
    .from(notionConnections)
    .where(eq(notionConnections.workspaceId, workspaceId));
  const active = connections.filter((c) => c.status === "active" && c.statusPropertyId);
  if (active.length === 0) return;

  // Steps 5-9 run independently per connection: each has its own
  // statusPropertyId / doneValues / token, so each applies its own cheap-reject
  // and done-check. Idempotency is per (tenantId, provider, externalId), so
  // there is no cross-tenant collision. One connection's failure must not abort
  // the others — mirror the fail-safe posture of the after() wrapper.
  const updated = payload.data?.updated_properties ?? [];
  const completedAt = payload.timestamp ? new Date(payload.timestamp) : new Date();

  for (const connection of active) {
    try {
      // Step 5: cheap rejection — most property edits are not status changes.
      if (!updated.includes(connection.statusPropertyId!)) continue;

      // Step 6: read current property values (refreshing the token on a 401).
      const page = await withFreshToken(db, connection, (token) => getPage(token, pageId));

      // Step 7: only ingest when the status value means "done".
      const statusValue = page.statusByPropertyId[connection.statusPropertyId!];
      if (!statusValue || !connection.doneValues.includes(statusValue)) continue;

      // Step 8: read the page body for the task's description — task detail
      // lives in the body, not a property. Fetched only after the done-check so
      // we don't pay for the extra API call on non-completing edits.
      const bodyText = await withFreshToken(db, connection, (token) => getPageBodyText(token, pageId));

      // Step 9: hand off to the shared ingestion pipeline. Out-of-order-safe:
      // use the payload timestamp for completedAt, not arrival time.
      await ingestNotionTask({
        tenantId: connection.tenantId,
        pageId,
        title: page.title,
        description: bodyText || null,
        url: page.url,
        completedAt,
      });
    } catch (error) {
      console.error(
        `Notion event processing failed for connection ${connection.id} (tenant ${connection.tenantId}):`,
        error
      );
    }
  }
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
