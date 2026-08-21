import { describe, it, expect, vi } from "vitest";
import {
  toRegistrableDomain,
  isRedirector,
  resolveRedirect,
  classifyDomain,
} from "../../../src/lib/ai-visibility/domains";

describe("toRegistrableDomain", () => {
  it("reduces a URL to eTLD+1", () => {
    expect(toRegistrableDomain("https://www.acme.com/pricing?utm_source=x")).toBe("acme.com");
    expect(toRegistrableDomain("https://blog.acme.com/post")).toBe("acme.com");
    expect(toRegistrableDomain("https://docs.eu.acme.com/")).toBe("acme.com");
    expect(toRegistrableDomain("acme.com")).toBe("acme.com");
    expect(toRegistrableDomain("HTTPS://ACME.COM./x")).toBe("acme.com");
  });

  it("keeps the whole suffix for the multi-part TLDs it knows", () => {
    expect(toRegistrableDomain("https://www.acme.co.uk/pricing")).toBe("acme.co.uk");
    expect(toRegistrableDomain("https://shop.acme.com.au")).toBe("acme.com.au");
    expect(toRegistrableDomain("https://acme.co.il")).toBe("acme.co.il");
    // Project hosts behave like suffixes for our purpose: two projects on
    // github.io are two different publishers, not one.
    expect(toRegistrableDomain("https://acme.github.io/docs")).toBe("acme.github.io");
  });

  it("keeps hosted-content tenants apart instead of merging them into one row", () => {
    expect(toRegistrableDomain("https://acme.zendesk.com/hc/en-us/articles/1")).toBe(
      "acme.zendesk.com"
    );
    expect(toRegistrableDomain("https://rival.zendesk.com/hc/en-us")).toBe("rival.zendesk.com");
    expect(toRegistrableDomain("https://acme.atlassian.net/wiki/x")).toBe("acme.atlassian.net");
    expect(toRegistrableDomain("https://acme.wordpress.com/2026/01/post")).toBe(
      "acme.wordpress.com"
    );
    expect(toRegistrableDomain("https://acme.blogspot.com/p/x.html")).toBe("acme.blogspot.com");
    expect(toRegistrableDomain("https://acme.webflow.io/")).toBe("acme.webflow.io");
    expect(toRegistrableDomain("https://acme.myshopify.com/products/x")).toBe(
      "acme.myshopify.com"
    );
    expect(toRegistrableDomain("https://acme.ghost.io/post")).toBe("acme.ghost.io");
  });

  it("returns null for what is not a host, and passes an IP through", () => {
    expect(toRegistrableDomain("")).toBeNull();
    expect(toRegistrableDomain("   ")).toBeNull();
    expect(toRegistrableDomain("not a url at all")).toBeNull();
    expect(toRegistrableDomain("https://93.184.216.34/x")).toBe("93.184.216.34");
    expect(toRegistrableDomain("http://localhost:3000/x")).toBe("localhost");
  });
});

describe("resolveRedirect", () => {
  it("leaves a normal URL alone without touching the network", async () => {
    const fetchImpl = vi.fn();

    expect(await resolveRedirect("https://acme.com/pricing", fetchImpl as never)).toBe(
      "https://acme.com/pricing"
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(isRedirector("https://acme.com/pricing")).toBe(false);
  });

  it("follows a Gemini grounding redirect to the real page", async () => {
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123";
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://acme.com/pricing" } })
    );

    expect(await resolveRedirect(redirect, fetchImpl as never)).toBe("https://acme.com/pricing");
    expect(isRedirector(redirect)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("resolves a relative Location against the redirector", async () => {
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123";
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "/elsewhere" } })
    );

    expect(await resolveRedirect(redirect, fetchImpl as never)).toBe(
      "https://vertexaisearch.cloud.google.com/elsewhere"
    );
  });

  it("returns the redirector itself rather than throwing when the hop fails", async () => {
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123";

    const thrower = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await resolveRedirect(redirect, thrower as never)).toBe(redirect);

    const noLocation = vi.fn(async () => new Response("", { status: 200 }));
    expect(await resolveRedirect(redirect, noLocation as never)).toBe(redirect);
  });

  it("bounds every hop with a timeout signal", async () => {
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123";
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://acme.com/pricing" } })
    );

    await resolveRedirect(redirect, fetchImpl as never);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("treats an aborted hop as unresolvable rather than throwing", async () => {
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123";
    const aborted = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });

    expect(await resolveRedirect(redirect, aborted as never)).toBe(redirect);
  });

  it("gives up rather than looping when a redirector points at itself", async () => {
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123";
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: redirect } })
    );

    expect(await resolveRedirect(redirect, fetchImpl as never)).toBe(redirect);
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("classifyDomain", () => {
  const context = { ownDomain: "acme.com", competitorDomains: ["rival.com", "Other.IO"] };

  it("puts us and our competitors first", () => {
    expect(classifyDomain("acme.com", context)).toBe("own");
    expect(classifyDomain("rival.com", context)).toBe("competitor");
    expect(classifyDomain("other.io", context)).toBe("competitor");
  });

  it("classifies the domain families the leaderboard reads", () => {
    expect(classifyDomain("g2.com", context)).toBe("review");
    expect(classifyDomain("capterra.com", context)).toBe("review");
    expect(classifyDomain("reddit.com", context)).toBe("community");
    expect(classifyDomain("ycombinator.com", context)).toBe("community");
    expect(classifyDomain("stackoverflow.com", context)).toBe("community");
    expect(classifyDomain("wikipedia.org", context)).toBe("wiki");
    expect(classifyDomain("readthedocs.io", context)).toBe("docs");
    expect(classifyDomain("techcrunch.com", context)).toBe("publisher");
    expect(classifyDomain("someblog.example", context)).toBe("other");
    expect(classifyDomain("", context)).toBe("other");
  });

  it("classifies a host under a multi-part suffix by its family, not as 'other'", () => {
    // These three sit in MULTI_PART_SUFFIXES, so toRegistrableDomain keeps the
    // tenant label. Classification still has to recognise the family, or every
    // Substack and ReadTheDocs citation silently becomes "other".
    expect(classifyDomain("someone.substack.com", context)).toBe("publisher");
    expect(classifyDomain("someproject.readthedocs.io", context)).toBe("docs");
    expect(classifyDomain("someteam.gitbook.io", context)).toBe("docs");
    // The bare forms keep working too.
    expect(classifyDomain("substack.com", context)).toBe("publisher");
    expect(classifyDomain("readthedocs.io", context)).toBe("docs");
    // A subdomain of a normally-classified domain resolves the same way.
    expect(classifyDomain("old.reddit.com", context)).toBe("community");
    // And an unknown tenant on an unknown suffix is still honestly "other".
    expect(classifyDomain("acme.zendesk.com", context)).toBe("other");
  });

  it("puts the tenant's own hosted subdomain ahead of its family", () => {
    const hosted = { ownDomain: "acme.substack.com", competitorDomains: ["rival.substack.com"] };
    expect(classifyDomain("acme.substack.com", hosted)).toBe("own");
    expect(classifyDomain("rival.substack.com", hosted)).toBe("competitor");
    expect(classifyDomain("stranger.substack.com", hosted)).toBe("publisher");
  });

  it("still works for a tenant with no site and no competitors", () => {
    expect(classifyDomain("acme.com", { ownDomain: null, competitorDomains: [] })).toBe("other");
    expect(classifyDomain("g2.com", { ownDomain: null, competitorDomains: [] })).toBe("review");
  });
});
