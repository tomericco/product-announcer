import type { PersonaRef, ResolvedPersona } from "@/db/schema";

type CatalogEntry = { key: string; name: string; brief: string };

/**
 * Flattens a brand profile's persona references into the `{ name, brief }` shape
 * used by the generation prompt and the settings UI. System references resolve
 * against the *current* catalog (live reference) and are dropped if their key no
 * longer exists; custom personas pass through (nameless ones are dropped).
 */
export function resolvePersonaRefs(refs: PersonaRef[], catalog: CatalogEntry[]): ResolvedPersona[] {
  const byKey = new Map(catalog.map((p) => [p.key, p]));
  const resolved: ResolvedPersona[] = [];

  for (const ref of refs) {
    if (ref.type === "custom") {
      if (ref.name.trim().length > 0) resolved.push({ name: ref.name, brief: ref.brief });
    } else {
      const sys = byKey.get(ref.key);
      if (sys) resolved.push({ name: sys.name, brief: sys.brief });
    }
  }

  return resolved;
}
