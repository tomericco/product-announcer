"use client";

import { GuardedLink } from "./unsaved-changes";
import { usePathname } from "next/navigation";
import {
  Building2,
  CalendarDays,
  ChevronDown,
  Columns3,
  Gauge,
  History,
  Images,
  MessageSquareQuote,
  Plug,
  Radar,
  ScanSearch,
  Settings,
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
  { href: "/company#ai-visibility", label: "AI visibility" },
  { href: "/company#industry", label: "Industry" },
  { href: "/company#user-personas", label: "User personas" },
  { href: "/company#derive-from-updates", label: "Derive from your updates page" },
  { href: "/company#guidelines", label: "Guidelines" },
  { href: "/company#visual-identity", label: "Visual identity" },
  { href: "/company#change-events", label: "Change events" },
  { href: "/company#atomic-updates", label: "Atomic updates" },
];

// Three groups, ordered by how often a workspace touches them: Content is the
// daily loop, AI visibility the weekly one, Workspace the set-up-once one.
// That frequency ordering is the whole point of the grouping — a flat list of
// nine made "where do I go for X" a scan of nine unrelated nouns.
const NAV_GROUPS = [
  {
    label: "Content",
    items: [
      { href: "/signals", label: "Signals", icon: Radar },
      { href: "/board", label: "Board", icon: Columns3 },
      { href: "/calendar", label: "Calendar", icon: CalendarDays },
      { href: "/history", label: "Release history", icon: History },
      { href: "/images", label: "Image library", icon: Images },
    ],
  },
  {
    label: "AI visibility",
    items: [
      // Labelled "Overview" rather than "AI visibility": the group heading
      // already says that, and repeating it inside the group is the naming
      // collision this restructure exists to remove.
      { href: "/ai-visibility", label: "Overview", icon: ScanSearch },
      { href: "/ai-visibility/prompts", label: "Prompts", icon: MessageSquareQuote },
    ],
  },
  {
    label: "Workspace",
    items: [
      { href: "/company", label: "Company", icon: Building2, children: COMPANY_SECTIONS },
      { href: "/integrations", label: "Integrations", icon: Plug },
      { href: "/usage", label: "AI usage", icon: Gauge },
      // Was reachable only from the workspace-name dropdown in `layout.tsx`,
      // which sat next to Integrations in kind but not in place.
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

const ALL_HREFS = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href));

/**
 * The one nav href that owns the current route: longest prefix match wins.
 *
 * A plain `pathname.startsWith(href)` per item was fine while no nav entry
 * nested under another, and stopped being fine when Prompts joined the nav at
 * `/ai-visibility/prompts` — that route prefixes Overview's `/ai-visibility`
 * too, so both would tint. Most-specific-wins keeps Prompts alone at its own
 * route while still letting a nested route with no nav entry of its own
 * (`/board/[id]`) hold its parent open.
 */
function activeHref(pathname: string): string | undefined {
  return ALL_HREFS.filter((href) => pathname === href || pathname.startsWith(`${href}/`)).sort(
    (a, b) => b.length - a.length
  )[0];
}

export function NavLinks({ boardCount }: { boardCount: number }) {
  const pathname = usePathname();
  const current = activeHref(pathname);

  return (
    <nav className="flex flex-col gap-4">
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="flex flex-col gap-1">
          {/* A label, not a control: the groups do not collapse, so there is
              nothing here to operate. Kept out of the tab order and announced
              as the nav section's heading. */}
          <div className="text-muted-foreground/70 px-2 text-[11px] font-normal tracking-wide uppercase">
            {group.label}
          </div>
          {group.items.map((item) => {
            const active = item.href === current;
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
                    // A deeper hover than the ghost variant's `bg-muted`, which
                    // is oklch 0.965 against a 0.975 sidebar — a tenth of a
                    // percent of lightness, all but invisible on this surface.
                    // Mixed off `--sidebar` rather than picked from the palette
                    // so the step is the same size in both themes: toward
                    // `--foreground` is darker in light and lighter in dark,
                    // which is what "more contrast than the surface" means on
                    // either.
                    !active &&
                      "hover:bg-[color-mix(in_oklch,var(--sidebar),var(--foreground)_8%)] hover:text-foreground",
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
                    <ChevronDown
                      aria-hidden="true"
                      className={cn("ml-auto size-4 shrink-0 transition-transform", !open && "-rotate-90")}
                    />
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
                    className={cn(
                      "grid transition-[grid-template-rows] duration-200 ease-out",
                      open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                    )}
                    aria-hidden={!open}
                  >
                    <div className="mt-1 ml-5 flex flex-col gap-0.5 overflow-hidden border-l pl-3">
                      {item.children.map((child) => (
                        <Button
                          key={child.href}
                          variant="ghost"
                          size="sm"
                          title={child.label}
                          tabIndex={open ? undefined : -1}
                          className="text-muted-foreground w-full justify-start overflow-hidden font-normal"
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
        </div>
      ))}
    </nav>
  );
}
