import { Badge } from "@/components/ui/badge";

// Split out of `atomic-updates/page.tsx` (its former home) when
// `atomic-update-card.tsx` moved to /company: this file's only import is the
// (client-safe) `Badge` primitive, unlike `atomic-updates-section.tsx`, which
// pulls in the "use server" read wrappers. `atomic-update-card.tsx` is a
// "use client" component, so it must never import a value from a module that
// also carries server-only imports — keeping the badges here, isolated, is
// what keeps that import safe.
export const CATEGORY_LABEL: Record<string, string> = {
  new: "New",
  improvement: "Improvement",
  fix: "Fix",
  announcement: "Announcement",
};

export function CategoryBadge({ category }: { category: string | null }) {
  if (!category) return null;
  return <Badge variant="secondary">{CATEGORY_LABEL[category] ?? category}</Badge>;
}

export function SizeBadge({ size }: { size: string | null }) {
  if (!size) return null;
  return <Badge variant="outline">{size.toUpperCase()}</Badge>;
}
