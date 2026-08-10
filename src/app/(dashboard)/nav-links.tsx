"use client";

import { GuardedLink } from "./unsaved-changes";
import { usePathname } from "next/navigation";
import {
  Activity,
  Building2,
  CalendarDays,
  Columns3,
  FilePen,
  History,
  Inbox,
  Plug,
  Radar,
  ToyBrick,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/change-events", label: "Change events", icon: Activity },
  { href: "/signals", label: "Signals", icon: Radar },
  { href: "/briefs", label: "Briefs", icon: Inbox },
  { href: "/board", label: "Board", icon: Columns3 },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/atomic-updates", label: "Atomic updates", icon: ToyBrick },
  { href: "/drafts", label: "Drafts", icon: FilePen },
  { href: "/history", label: "Release history", icon: History },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/company", label: "Company", icon: Building2 },
];

export function NavLinks({ draftCount }: { draftCount: number }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => {
        // Highlight the item for its own route and any nested route under it
        // (e.g. /drafts/[updateId] keeps "Drafts" active).
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;
        return (
          <Button
            key={item.href}
            variant="ghost"
            className={cn(
              "justify-start font-normal",
              // Current location is one of the three things the accent marks.
              // hover: is repeated so the ghost variant's hover:bg-muted does
              // not knock the active tint out from under the pointer.
              active &&
                "bg-brand-subtle text-brand-subtle-foreground font-medium hover:bg-brand-subtle hover:text-brand-subtle-foreground"
            )}
            aria-current={active ? "page" : undefined}
            render={<GuardedLink href={item.href} />}
          >
            {/* Muted when idle so the label leads; the active item's accent
                colour is inherited instead. */}
            <Icon className={cn(!active && "text-muted-foreground")} />
            {item.label}
            {item.href === "/drafts" && draftCount > 0 && (
              <Badge variant="secondary" className="ml-auto">
                {draftCount}
              </Badge>
            )}
          </Button>
        );
      })}
    </nav>
  );
}
