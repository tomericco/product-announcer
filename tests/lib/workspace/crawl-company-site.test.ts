import { describe, it, expect } from "vitest";
import { crawlCompanySite } from "../../../src/lib/workspace/crawl-company-site";
import type { PageResult } from "../../../src/lib/workspace/fetch-page";

const LONG = "x".repeat(300);

function fakeFetcher(pages: Record<string, PageResult>) {
  const calls: string[] = [];
  const fetchPage = async (url: string): Promise<PageResult> => {
    calls.push(url);
    return pages[url] ?? { error: "fetch-failed" };
  };
  return { fetchPage, calls };
}

describe("crawlCompanySite", () => {
  it("returns the homepage error when the homepage cannot be fetched", async () => {
    const { fetchPage } = fakeFetcher({});
    expect(await crawlCompanySite("https://acme.com/", { fetchPage })).toEqual({ error: "fetch-failed" });
  });

  it("fetches the homepage plus keyword-matched same-origin pages, homepage first", async () => {
    const home = {
      text: `home ${LONG}`,
      html: `<a href="/product">p</a><a href="/about">a</a><a href="/careers">c</a>`,
      finalUrl: "https://acme.com/",
      contentType: "text/html",
    };
    const { fetchPage, calls } = fakeFetcher({
      "https://acme.com/": home,
      "https://acme.com/product": { text: `product ${LONG}`, html: "", finalUrl: "https://acme.com/product", contentType: "text/html" },
      "https://acme.com/about": { text: `about ${LONG}`, html: "", finalUrl: "https://acme.com/about", contentType: "text/html" },
    });

    const result = await crawlCompanySite("https://acme.com/", { fetchPage });
    if ("error" in result) throw new Error("expected success");

    expect(calls).toEqual(["https://acme.com/", "https://acme.com/product", "https://acme.com/about"]);
    expect(result.pages).toEqual(["https://acme.com/", "https://acme.com/product", "https://acme.com/about"]);
    expect(result.text).toContain("home");
    expect(result.text).toContain("product");
    expect(result.text).toContain("about");
    expect(result.text).not.toContain("careers");
  });

  it("succeeds on the homepage alone when no secondary page matches or fetches", async () => {
    const { fetchPage } = fakeFetcher({
      "https://acme.com/": {
        text: `home ${LONG}`,
        html: `<a href="/careers">c</a>`,
        finalUrl: "https://acme.com/",
        contentType: "text/html",
      },
    });
    const result = await crawlCompanySite("https://acme.com/", { fetchPage });
    if ("error" in result) throw new Error("expected success");
    expect(result.pages).toEqual(["https://acme.com/"]);
  });

  it("fetches at most three secondary pages", async () => {
    const html = ["/product", "/about", "/pricing", "/platform", "/features"]
      .map((p) => `<a href="${p}">${p}</a>`)
      .join("");
    const pages: Record<string, PageResult> = {
      "https://acme.com/": { text: `home ${LONG}`, html, finalUrl: "https://acme.com/", contentType: "text/html" },
    };
    for (const p of ["/product", "/about", "/pricing", "/platform", "/features"]) {
      pages[`https://acme.com${p}`] = {
        text: `${p} ${LONG}`,
        html: "",
        finalUrl: `https://acme.com${p}`,
        contentType: "text/html",
      };
    }
    const { fetchPage, calls } = fakeFetcher(pages);
    await crawlCompanySite("https://acme.com/", { fetchPage });
    expect(calls).toHaveLength(4); // homepage + 3
  });

  it("caps combined text length", async () => {
    const huge = "y".repeat(30_000);
    const { fetchPage } = fakeFetcher({
      "https://acme.com/": {
        text: huge,
        html: `<a href="/product">p</a>`,
        finalUrl: "https://acme.com/",
        contentType: "text/html",
      },
      "https://acme.com/product": { text: huge, html: "", finalUrl: "https://acme.com/product", contentType: "text/html" },
    });
    const result = await crawlCompanySite("https://acme.com/", { fetchPage });
    if ("error" in result) throw new Error("expected success");
    expect(result.text.length).toBeLessThanOrEqual(24_000);
  });
});
