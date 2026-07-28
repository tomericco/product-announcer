import { getServerSession } from "next-auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/workspace/auth";
import { hasValidSession } from "@/lib/workspace/session";
import { ACTIVE_TENANT_COOKIE, resolveActiveTenant } from "@/lib/workspace/active-tenant";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";

/**
 * Shown to a signed-in user who belongs to no workspace — chiefly a personal-email
 * signup, which is not allowed to create one.
 *
 * Uses getServerSession directly: requireSession() redirects HERE when there is no
 * membership, so calling it would loop.
 */
export default async function WorkEmailRequiredPage() {
  const session = await getServerSession(authOptions);
  if (!hasValidSession(session)) redirect("/signin");

  // A user who does have a workspace has no business on this page — most likely a
  // stale bookmark, or they accepted an invite in another tab.
  const store = await cookies();
  const active = await resolveActiveTenant(session.user.id, store.get(ACTIVE_TENANT_COOKIE)?.value);
  if (active) redirect("/");

  const email = session.user.email;

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-5 text-center">
          <Logo />
          <div className="space-y-1.5">
            <h1 className="font-heading text-4xl leading-[1.15] tracking-[0.015em] text-balance">
              Use your work email
            </h1>
            <p className="text-muted-foreground text-sm">
              versional workspaces are created for teams, so we can&apos;t set one up for a personal
              account{email ? ` like ${email}` : ""}.
            </p>
          </div>
        </div>
        <Card>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Sign in again with your company account and we&apos;ll get your workspace ready. If a
              teammate invited you, open their invite link instead — that works with any address.
            </p>
            {/* Sign out first: without clearing the session the provider silently
                re-picks the same personal account and the user loops back here.
                /api/auth/signout is a NextAuth route (the [...nextauth] catch-all), not a
                Next.js page, so the lint rule below false-positives on it — a plain <a> is
                correct here since it must force a real browser navigation. */}
            <Button
              className="w-full"
              // eslint-disable-next-line @next/next/no-html-link-for-pages
              render={<a href="/api/auth/signout?callbackUrl=/signin" />}
            >
              Sign in with your work account
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
