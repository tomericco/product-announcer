import Link from "next/link";
import { cn } from "@/lib/utils";

export type SettingsTab = "workspace" | "usage";

const TABS: { key: SettingsTab; label: string; href: string }[] = [
  { key: "workspace", label: "Workspace", href: "/settings" },
  { key: "usage", label: "AI usage", href: "/settings?tab=usage" },
];

/**
 * Links styled as tab pills rather than the client `Tabs` component: the
 * active tab is server state (the `?tab=` search param), the panels are
 * Server Components that must not both render, and a link keeps deep links,
 * back/forward and the sidebar's `#ai-engines` anchors working with no
 * hydration. Mirrors the ui/tabs.tsx pill styling.
 */
export function SettingsTabs({ active }: { active: SettingsTab }) {
  return (
    <nav
      aria-label="Settings sections"
      className="inline-flex w-fit items-center justify-center rounded-lg bg-muted p-[3px]"
    >
      {TABS.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === active ? "page" : undefined}
          className={cn(
            "inline-flex items-center justify-center rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap transition-all",
            tab.key === active
              ? "bg-background text-foreground shadow-sm"
              : "text-foreground/60 hover:text-foreground"
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
