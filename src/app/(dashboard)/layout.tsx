import Link from "next/link";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { ChevronsUpDown } from "lucide-react";
import { db } from "@/db";
import { tenants } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { isOnboardingComplete } from "@/lib/onboarding";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const NAV = [
  { href: "/pending", label: "Pending" },
  { href: "/drafts", label: "Drafts" },
  { href: "/history", label: "History" },
  { href: "/integrations", label: "Integrations" },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const complete = await isOnboardingComplete(session.user.tenantId);
  if (!complete) redirect("/onboarding");

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col gap-1 border-r p-3">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" className="w-full justify-between font-semibold" />}>
            {tenant?.name ?? "Workspace"}
            <ChevronsUpDown className="size-4 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[13rem]">
            <DropdownMenuItem render={<Link href="/settings" />}>Settings</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Separator className="my-2" />

        <nav className="flex flex-col gap-1">
          {NAV.map((item) => (
            <Button key={item.href} variant="ghost" className="justify-start font-normal" render={<Link href={item.href} />}>
              {item.label}
            </Button>
          ))}
        </nav>

        <div className="mt-auto px-2 pt-3 text-xs text-muted-foreground">{session.user.email}</div>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
