import { getServerSession } from "next-auth";
import { cookies } from "next/headers";
import { authOptions } from "@/lib/workspace/auth";
import { hasValidSession } from "@/lib/workspace/session";
import { ACTIVE_TENANT_COOKIE, resolveActiveTenant } from "@/lib/workspace/active-tenant";
import { blobPathnameFromUrl, readBrandAsset } from "@/lib/images/blob";

/**
 * Streams a style reference image's bytes back to the dashboard. The store is
 * private (product decision: brand inputs are never delivered to a reader,
 * Webflow, LinkedIn, or a webhook subscriber, so unlike content images they
 * don't need a bare-fetchable URL) and the browser has no Blob token, so
 * every `<Image src>` pointed at a style reference goes through this route
 * instead of the raw blob URL.
 *
 * `url` is the full blob URL exactly as stored in `styleReferenceImages`, not
 * a caller-derived route param — checked against the resolved tenant's own
 * `tenants/{tenantId}/brand/` prefix before any read happens, the same
 * ownership check `removeStyleReference` (company/actions.ts) uses on
 * delete. Array membership in the identity's own `styleReferenceImages` is
 * not proof of ownership (the cross-tenant class this branch has fixed
 * twice already), so this is the read-time version of that same guard.
 */
export async function GET(req: Request): Promise<Response> {
  const session = await getServerSession(authOptions);
  if (!hasValidSession(session)) {
    return new Response(null, { status: 401 });
  }
  const store = await cookies();
  const cookieTenantId = store.get(ACTIVE_TENANT_COOKIE)?.value;
  const active = await resolveActiveTenant(session.user.id, cookieTenantId);
  if (!active) {
    return new Response(null, { status: 401 });
  }

  const url = new URL(req.url).searchParams.get("url");
  if (!url) return new Response(null, { status: 400 });

  const pathname = blobPathnameFromUrl(url);
  if (!pathname.startsWith(`tenants/${active.tenantId}/brand/`)) {
    return new Response(null, { status: 404 });
  }

  const asset = await readBrandAsset(url);
  if (!asset) return new Response(null, { status: 404 });

  return new Response(new Uint8Array(asset.bytes), {
    headers: {
      "content-type": asset.contentType ?? "image/png",
      // Private: this tenant's own brand asset, not something a CDN or a
      // shared cache should hold.
      "cache-control": "private, max-age=3600",
    },
  });
}
