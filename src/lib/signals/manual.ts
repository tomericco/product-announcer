import { db as defaultDb } from "@/db";
import { signals } from "@/db/schema";
import { normalizeArticleUrl } from "./news-agent";

export type ManualSignalInput = {
  title: string;
  url?: string | null;
  excerpt?: string | null;
  occurredAt?: Date | null;
};

export type ManualSignalResult = { ok: true; id: string } | { ok: false; error: string };

// A unique-violation on signals_tenant_kind_external_unique (Postgres code
// 23505) — the same link entered twice for this tenant. Drizzle wraps the
// driver error in a DrizzleQueryError and puts the original pg error on
// `.cause`, so walk the cause chain rather than assuming exactly one level
// of wrapping.
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current !== null && typeof current === "object") {
    const code = (current as { code?: unknown }).code;
    if (code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Records a signal a human found — a competitor post, webinar, or talk the
 * agents missed — rather than one an agent produced.
 *
 * `externalId` is `signals.externalId`'s identity function: with a `url`,
 * `normalizeArticleUrl` gives the same key every other signal producer would
 * give that link, so entering the same URL twice trips
 * `signals_tenant_kind_external_unique` and is reported back as a duplicate
 * instead of writing a second row. Without a `url`, a generated UUID is used
 * instead, so two signals that merely share a title never collide.
 *
 * `relevanceScore` is left unset (null) — a human-entered signal was never
 * scored, and null means "not scored", not "scored zero".
 */
export async function createManualSignal(
  tenantId: string,
  input: ManualSignalInput,
  database: typeof defaultDb = defaultDb
): Promise<ManualSignalResult> {
  const title = input.title.trim();
  if (!title) {
    return { ok: false, error: "Title is required." };
  }

  const url = input.url?.trim() || null;
  const externalId = url ? normalizeArticleUrl(url) : crypto.randomUUID();

  try {
    const [row] = await database
      .insert(signals)
      .values({
        tenantId,
        kind: "manual",
        externalId,
        url,
        title,
        excerpt: input.excerpt?.trim() || null,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .returning({ id: signals.id });

    return { ok: true, id: row.id };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { ok: false, error: "You already have a signal for this link." };
    }
    throw error;
  }
}
