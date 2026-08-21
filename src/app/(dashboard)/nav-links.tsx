"use client";

import { GuardedLink } from "./unsaved-changes";
import { usePathname } from "next/navigation";
import {
  Building2,
  CalendarDays,
  ChevronDown,
  Columns3,
  History,
  Images,
  Plug,
  Radar,
  ScanSearch,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Company's sections all live on one page (`/company`) rather than separate
// routes, so its children are hash links into that page rather than distinct
// hrefs — anchors match the `id` on each Card in `company/page.tsx`.
const COMPANY_SECTIONS = [
  { href: "/company#company-context", label: "Company context" },
  { href: "/company#competitors", label: "Competitors" },
  { href: "/company#industry-news", label: "Industry news" },
  { href: "/company#industry", label: "Industry" },
  { href: "/company#user-personas", label: "User personas" },
  { href: "/company#derive-from-updates", label: "Derive from your updates page" },
  { href: "/company#guidelines", label: "Guidelines" },
  { href: "/company#visual-identity", label: "Visual identity" },
  { href: "/company#change-events", label: "Change events" },
  { href: "/company#atomic-updates", label: "Atomic updates" },
];

const NAV = [
  { href: "/signals", label: "Signals", icon: Radar },
  // Directly after Signals: the two are read in the same weekly pass, and the
  // AI-visibility signals land in that browser.
  { href: "/ai-visibility", label: "AI visibility", icon: ScanSearch },
  { href: "/board", label: "Board", icon: Columns3 },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/history", label: "Release history", icon: History },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/company", label: "Company", icon: Building2, children: COMPANY_SECTIONS },
  { href: "/images", label: "Image library", icon: Images },
];

export function NavLinks({ boardCount }: { boardCount: number }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => {
        // Highlight the item for its own route and any nested route under it
        // (e.g. a future /board/[id] would keep "Board" active).
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        // No independent toggle: Company's sections track the route, full
        // stop — open exactly when Company (or a hash under it) is current,
        // closed otherwise. Not a `useState`, so there is nothing to get out
        // of sync with the route.
        const open = active;
        const Icon = item.icon;
        return (
          <div key={item.href}>
            <Button
              variant="ghost"
              className={cn(
                "w-full justify-start font-normal",
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
              <Icon className={cn("shrink-0", !active && "text-muted-foreground")} />
              <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
              {item.href === "/board" && boardCount > 0 && (
                <Badge variant="secondary" className="ml-auto">
                  {boardCount}
                </Badge>
              )}
              {/* A state indicator only, not a control: no independent
                  toggle, so this is decorative (aria-hidden) rather than a
                  role="button" — there is nothing here for a screen reader
                  or keyboard user to interact with. */}
              {item.children && (
                <ChevronDown aria-hidden="true" className={cn("ml-auto size-4 shrink-0 transition-transform", !open && "-rotate-90")} />
              )}
            </Button>
            {/* All hashes share one route, so there's no per-section active
                state to track — only the parent tints when the pathname is
                /company. Labels truncate: the indented column is narrower
                than the sidebar, and a couple of section names ("Derive from
                your updates page") don't fit — `title` carries the full text.
                The grid-rows 0fr/1fr trick animates height smoothly without
                measuring the content in JS (no Collapsible primitive exists
                in this codebase); the inner `overflow-hidden` clips it as
                that row shrinks, and `aria-hidden` keeps a screen reader from
                announcing links that are visually gone. */}
            {item.children && (
              <div
                className={cn("grid transition-[grid-template-rows] duration-200 ease-out", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}
                aria-hidden={!open}
              >
                <div className="mt-1 flex flex-col gap-0.5 overflow-hidden border-l ml-5 pl-3">
                  {item.children.map((child) => (
                    <Button
                      key={child.href}
                      variant="ghost"
                      size="sm"
                      title={child.label}
                      tabIndex={open ? undefined : -1}
                      className="w-full justify-start overflow-hidden font-normal text-muted-foreground"
                      render={<GuardedLink href={child.href} />}
                    >
                      <span className="truncate">{child.label}</span>
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
