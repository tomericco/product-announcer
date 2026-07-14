import Link from "next/link";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { tenants } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { isOnboardingComplete } from "@/lib/onboarding";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const complete = await isOnboardingComplete(session.user.tenantId);
  if (!complete) redirect("/onboarding");

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-gray-200 p-3">
        <details className="relative">
          <summary className="flex cursor-pointer list-none items-center justify-between rounded-md px-2 py-2 text-sm font-semibold text-gray-900 hover:bg-gray-100 [&::-webkit-details-marker]:hidden">
            {tenant?.name ?? "Workspace"}
            <span className="text-gray-400">▾</span>
          </summary>
          <div className="absolute left-0 right-0 z-10 mt-1 rounded-md border border-gray-200 bg-white py-1">
            <Link href="/settings" className="block px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
              Settings
            </Link>
          </div>
        </details>
        <nav className="mt-4 flex flex-col gap-1">
          <Link href="/pending" className="rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
            Pending
          </Link>
          <Link href="/drafts" className="rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
            Drafts
          </Link>
          <Link href="/history" className="rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
            History
          </Link>
          <Link href="/integrations" className="rounded-md px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-100">
            Integrations
          </Link>
        </nav>
        <div className="mt-auto border-t border-gray-200 px-2 pt-3 text-xs text-gray-500">
          {session.user.email}
        </div>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
