"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";

const NAV = [
  { href: "/pending", label: "Pending" },
  { href: "/drafts", label: "Drafts" },
  { href: "/history", label: "History" },
  { href: "/integrations", label: "Integrations" },
];

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => {
        // Highlight the item for its own route and any nested route under it
        // (e.g. /pending/schedule-choice keeps "Pending" active).
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Button
            key={item.href}
            variant={active ? "secondary" : "ghost"}
            className="justify-start font-normal"
            aria-current={active ? "page" : undefined}
            render={<Link href={item.href} />}
          >
            {item.label}
          </Button>
        );
      })}
    </nav>
  );
}
