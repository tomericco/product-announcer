"use client";

import { GuardedLink } from "./unsaved-changes";
import { usePathname } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/change-events", label: "Change events" },
  { href: "/atomic-updates", label: "Atomic updates" },
  { href: "/drafts", label: "Drafts" },
  { href: "/history", label: "Release history" },
  { href: "/integrations", label: "Integrations" },
];

export function NavLinks({ draftCount }: { draftCount: number }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => {
        // Highlight the item for its own route and any nested route under it
        // (e.g. /drafts/[updateId] keeps "Drafts" active).
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
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
