/**
 * Only a URL that will be rendered as an `href` and is honestly fetchable.
 *
 * `signals.url` (and `signals.fetchedUrl`) is third-party data on every kind
 * the evidence dialog serves — a Tavily search result, a competitor's own
 * page, or a hand-typed field on the manual form — so it gets the same
 * treatment `toRegistrableDomain` documents for cited URLs:
 * `javascript://evil.com/%0aalert(1)` parses as an ordinary URL with a
 * perfectly good hostname, and dropping the scheme check would keep the
 * payload. React refusing to render it today is a framework internal, not a
 * decision this code made.
 *
 * Lives here rather than beside its one caller because that caller is a
 * `"use server"` module, and those may export nothing but async functions —
 * a sync export there is a BUILD error (`Server Actions must be async
 * functions`) that neither tsc nor eslint reports.
 */
export function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    new URL(raw);
  } catch {
    return null;
  }
  return raw;
}
