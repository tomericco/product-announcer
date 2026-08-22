import type { SignalFilters } from "./query";

const KIND_VALUES = [
  "shipped_work",
  "competitor_move",
  "market_news",
  "manual",
  "ai_visibility",
] as const;

// Matches any RFC 4122 UUID (the shape `crypto.randomUUID()` produces), not a
// specific version — `competitorId` only ever needs to look like a uuid
// before it reaches a `= any` comparison against a uuid column.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseKind(value: string | undefined): SignalFilters["kind"] {
  return (KIND_VALUES as readonly string[]).includes(value ?? "")
    ? (value as SignalFilters["kind"])
    : undefined;
}

/**
 * `competitorId` is the one filter that reaches a uuid-typed column
 * (`signals.competitorId`) unmodified. Every other filter is whitelisted
 * against a closed set of values or coerced through `Number`, so a garbage
 * `competitorId` was the one value that could reach Postgres raw — a
 * non-uuid there raises `22P02` inside the Server Component and turns
 * `/signals?competitorId=x` into a hard error page with no "Clear filters"
 * escape (the page never renders far enough to show the button).
 */
export function parseCompetitorId(value: string | undefined): string | undefined {
  return value && UUID_RE.test(value) ? value : undefined;
}

export function parseMinScore(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const score = Number(value);
  return Number.isFinite(score) ? score : undefined;
}

/** Start of the range: midnight on the given date is the correct lower bound. */
export function parseDateFrom(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * End of the range, made inclusive of the whole day. A bare date string like
 * `"2026-07-15"` parses to `T00:00:00.000Z` — used directly with
 * `lte(occurredAt, to)`, that drops everything that happened later that same
 * day, so picking one date as both `from` and `to` would return nothing.
 * Bumped to the last millisecond of that day when the input is date-only (the
 * only shape the date picker actually sends); a value that already carries a
 * time component is trusted as-is.
 */
export function parseDateTo(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  if (!DATE_ONLY_RE.test(value)) return date;
  return new Date(date.getTime() + 24 * 60 * 60 * 1000 - 1);
}
