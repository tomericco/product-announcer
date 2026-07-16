import type { Persona } from "@/db/schema";

export function parsePersonas(formData: FormData): Persona[] {
  const raw = formData.get("personas");
  if (typeof raw !== "string") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .map((p) => ({
      name: typeof p.name === "string" ? p.name.trim() : "",
      usage: typeof p.usage === "string" ? p.usage.trim() : "",
      deliveredValue: typeof p.deliveredValue === "string" ? p.deliveredValue.trim() : "",
    }))
    .filter((p) => p.name.length > 0);
}
