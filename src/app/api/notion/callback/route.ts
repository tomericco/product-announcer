import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { notionConnections } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { encryptSecret } from "@/lib/credentials/encryption";
import { exchangeCode } from "@/lib/integrations/notion/oauth";

export async function GET(request: NextRequest) {
  const session = await requireSession();

  // Use `new URL(request.url)` rather than `request.nextUrl`: the test suite
  // exercises this handler with a plain `Request`, which lacks `nextUrl`.
  // Both give equivalent search params for a real `NextRequest`.
  const searchParams = new URL(request.url).searchParams;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const [tenantIdFromState] = (state ?? "").split("|");

  if (!code || tenantIdFromState !== session.user.tenantId) {
    return NextResponse.redirect(new URL("/integrations?notion_connect=error", request.url));
  }

  try {
    const tokens = await exchangeCode(code);
    const access = encryptSecret(tokens.accessToken);
    const refresh = tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null;

    const values = {
      accessTokenCiphertext: access.ciphertext,
      accessTokenIv: access.iv,
      accessTokenAuthTag: access.authTag,
      refreshTokenCiphertext: refresh?.ciphertext ?? null,
      refreshTokenIv: refresh?.iv ?? null,
      refreshTokenAuthTag: refresh?.authTag ?? null,
      workspaceId: tokens.workspaceId,
      botId: tokens.botId,
      // Re-authorizing must not silently keep a stale, half-finished mapping.
      // Reset to misconfigured; the tenant re-picks database + completion.
      status: "misconfigured" as const,
    };

    const [existing] = await db
      .select()
      .from(notionConnections)
      .where(eq(notionConnections.tenantId, session.user.tenantId))
      .limit(1);

    if (existing) {
      await db.update(notionConnections).set(values).where(eq(notionConnections.id, existing.id));
    } else {
      await db.insert(notionConnections).values({ tenantId: session.user.tenantId, ...values });
    }

    return NextResponse.redirect(new URL("/integrations?notion_connect=success", request.url));
  } catch (error) {
    console.error("Notion OAuth callback failed:", error);
    return NextResponse.redirect(new URL("/integrations?notion_connect=error", request.url));
  }
}
