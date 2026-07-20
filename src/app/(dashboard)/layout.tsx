import { UnsavedChangesProvider, GuardedLink } from "./unsaved-changes";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { ChevronsUpDown } from "lucide-react";
import { db } from "@/db";
import { tenants } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { isOnboardingComplete } from "@/lib/workspace/onboarding";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NavLinks } from "./nav-links";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const complete = await isOnboardingComplete(session.user.tenantId);
  if (!complete) redirect("/onboarding");

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);

  return (
    <UnsavedChangesProvider>
      <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col gap-1 self-start overflow-y-auto border-r p-3">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" className="w-full justify-between font-semibold" />}>
            {tenant?.name ?? "Workspace"}
            <ChevronsUpDown className="size-4 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[13rem]">
            <DropdownMenuItem render={<GuardedLink href="/settings" />}>Settings</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Separator className="my-2" />

        <NavLinks />

        <div className="mt-auto px-2 pt-3 text-xs text-muted-foreground">{session.user.email}</div>
      </aside>
        <main className="flex flex-1 flex-col p-8">
          <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col">{children}</div>
        </main>
      </div>
    </UnsavedChangesProvider>
  );
}
