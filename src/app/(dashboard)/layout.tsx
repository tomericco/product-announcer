import { UnsavedChangesProvider } from "./unsaved-changes";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { tenants } from "@/db/schema";
import { readBoardNavCount } from "@/lib/content/board";
import { requireSession } from "@/lib/workspace/session";
import { isOnboardingComplete } from "@/lib/workspace/onboarding";
import { NavLinks } from "./nav-links";
import { UserMenu } from "./user-menu";
import { Logo } from "@/components/brand/logo";
import { MainContainer } from "./main-container";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const complete = await isOnboardingComplete(session.user.tenantId);
  if (!complete) redirect("/onboarding");

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);

  // See the doc comment on readBoardNavCount for what this counts and why
  // it cannot honour /board's assignee filter.
  const boardCount = await readBoardNavCount(session.user.tenantId);

  return (
    <UnsavedChangesProvider>
      <div className="flex min-h-screen">
      <aside className="bg-sidebar sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-1 self-start overflow-y-auto border-r p-3">
        <div className="px-2 pt-1.5 pb-3">
          <Logo />
        </div>

        {/* Plain label, not a menu. Its only item was Settings, which now sits
            in the nav's Workspace group next to Integrations — a menu holding
            a link that is already one scroll below it is just a second place
            to look. Becomes a trigger again the day there is more than one
            workspace to switch between. */}
        <div className="mb-3 truncate px-3 py-1.5 font-semibold" title={tenant?.name ?? undefined}>
          {tenant?.name ?? "Workspace"}
        </div>

        <NavLinks boardCount={boardCount} />

        <div className="mt-auto pt-3">
          <UserMenu email={session.user.email!} name={session.user.name ?? null} />
        </div>
      </aside>
        <main className="flex min-w-0 flex-1 flex-col p-8">
          <MainContainer>{children}</MainContainer>
        </main>
      </div>
    </UnsavedChangesProvider>
  );
}
