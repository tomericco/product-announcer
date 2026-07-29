import type { PersonaRef } from "@/db/schema";

export function parsePersonas(formData: FormData): PersonaRef[] {
  const raw = formData.get("personas");
  if (typeof raw !== "string") return [];

  try {
    return sanitizePersonas(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * Validates an already-decoded persona list. Split out from `parsePersonas` so
 * the auto-saving personas card, which posts an array straight to a Server
 * Action rather than through a form, runs the same validation — client input is
 * no more trustworthy for arriving as an argument than as a form field.
 */
export function sanitizePersonas(parsed: unknown): PersonaRef[] {
  if (!Array.isArray(parsed)) return [];

  const result: PersonaRef[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;

    if (obj.type === "system") {
      const key = typeof obj.key === "string" ? obj.key.trim() : "";
      if (key) result.push({ type: "system", key });
    } else if (obj.type === "custom") {
      const name = typeof obj.name === "string" ? obj.name.trim() : "";
      const brief = typeof obj.brief === "string" ? obj.brief.trim() : "";
      if (name) result.push({ type: "custom", name, brief });
    }
  }
  return result;
}
