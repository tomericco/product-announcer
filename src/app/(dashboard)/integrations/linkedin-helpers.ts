// Plain (non-"use server") helpers shared by linkedin-actions.ts and, per the
// destination guard, by publishing code. Kept out of linkedin-actions.ts
// because a "use server" file's exports must all be async Server Actions —
// Next.js's build fails otherwise ("Server Actions must be async functions").

export function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw); // throws on relative
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL must be an http(s) URL.");
  }
  const s = url.toString();
  return s.endsWith("/") ? s : `${s}/`;
}

// Company-only backstop, shared by the save action and the destination guard.
export function isOrganizationUrn(urn: string): boolean {
  return urn.startsWith("urn:li:organization:");
}
