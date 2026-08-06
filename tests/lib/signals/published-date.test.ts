import { describe, it, expect } from "vitest";
import { extractPublishedDate, MAX_DATE_SCAN_CHARS } from "../../../src/lib/signals/published-date";

const iso = (d: { date: Date } | null) => d?.date.toISOString() ?? null;

describe("extractPublishedDate", () => {
  it("reads article:published_time, the most reliable source", () => {
    const html = `<html><head><meta property="article:published_time" content="2026-08-01T09:30:00Z"></head></html>`;
    expect(iso(extractPublishedDate(html))).toBe("2026-08-01T09:30:00.000Z");
    expect(extractPublishedDate(html)?.source).toBe("meta");
  });

  it("falls back to og:published_time", () => {
    const html = `<meta property="og:published_time" content="2026-07-15T00:00:00Z">`;
    expect(iso(extractPublishedDate(html))).toBe("2026-07-15T00:00:00.000Z");
    expect(extractPublishedDate(html)?.source).toBe("meta");
  });

  it("falls back to JSON-LD datePublished", () => {
    const html = `<script type="application/ld+json">{"@type":"Article","datePublished":"2026-06-02T12:00:00Z"}</script>`;
    expect(iso(extractPublishedDate(html))).toBe("2026-06-02T12:00:00.000Z");
    expect(extractPublishedDate(html)?.source).toBe("jsonld");
  });

  it("falls back to a time element's datetime attribute", () => {
    const html = `<article><time datetime="2026-05-20">May 20</time></article>`;
    expect(extractPublishedDate(html)?.date.getUTCFullYear()).toBe(2026);
    // Reported as the weak source it is: the first <time> on a page is as
    // likely to be a "recent posts" widget or a comment stamp as the article's
    // own date, and the caller must not delete an article on its say-so.
    expect(extractPublishedDate(html)?.source).toBe("time");
  });

  it("prefers article:published_time over the later sources", () => {
    const html = `
      <meta property="article:published_time" content="2026-08-01T00:00:00Z">
      <meta property="og:published_time" content="2020-01-01T00:00:00Z">
      <time datetime="1999-01-01">old</time>`;
    expect(iso(extractPublishedDate(html))).toBe("2026-08-01T00:00:00.000Z");
  });

  it("accepts single-quoted attributes and reversed attribute order", () => {
    const html = `<meta content='2026-04-04T00:00:00Z' property='article:published_time'>`;
    expect(iso(extractPublishedDate(html))).toBe("2026-04-04T00:00:00.000Z");
  });

  it("returns null when the page carries no date at all", () => {
    expect(extractPublishedDate("<html><body><p>No date here.</p></body></html>")).toBeNull();
  });

  it("rejects an unparseable value rather than returning an invalid Date", () => {
    const html = `<meta property="article:published_time" content="not a date">`;
    expect(extractPublishedDate(html)).toBeNull();
  });

  it("rejects a future date as a template artefact", () => {
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 400).toISOString();
    expect(extractPublishedDate(`<meta property="article:published_time" content="${future}">`)).toBeNull();
  });

  it("rejects a pre-2000 date as a template artefact", () => {
    expect(extractPublishedDate(`<meta property="article:published_time" content="0001-01-01T00:00:00Z">`)).toBeNull();
  });

  it("falls through to a later source when the first one is implausible", () => {
    const html = `
      <meta property="article:published_time" content="0001-01-01T00:00:00Z">
      <meta property="og:published_time" content="2026-07-15T00:00:00Z">`;
    // A rejected date must `continue` to the next pattern, not abandon the search.
    expect(extractPublishedDate(html)?.date.toISOString()).toBe("2026-07-15T00:00:00.000Z");
  });

  it("is bounded against repeated anchors with no closing bracket", () => {
    // The shape that actually triggers quadratic backtracking: many anchor
    // literals, no '>' to terminate the span. Measured at 11.5s on 100KB
    // before the {0,400} bound.
    const hostile = "<meta".repeat(20_000);
    const start = Date.now();
    extractPublishedDate(hostile);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("only scans the first MAX_DATE_SCAN_CHARS", () => {
    const buried = "x".repeat(MAX_DATE_SCAN_CHARS + 100) +
      `<meta property="article:published_time" content="2026-08-01T00:00:00Z">`;
    expect(extractPublishedDate(buried)).toBeNull();
  });
});
