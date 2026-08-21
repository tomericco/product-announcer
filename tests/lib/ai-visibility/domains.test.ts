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

describe("toRegistrableDomain, across the whole suffix table and the odd hosts", () => {
  it("keeps the third label for every multi-part ccTLD suffix it lists", () => {
    expect(toRegistrableDomain("https://www.acme.org.uk/x")).toBe("acme.org.uk");
    expect(toRegistrableDomain("https://a.b.c.d.acme.co.jp/x")).toBe("acme.co.jp");
    expect(toRegistrableDomain("https://shop.acme.com.br")).toBe("acme.com.br");
    expect(toRegistrableDomain("https://acme.com.mx/x")).toBe("acme.com.mx");
    expect(toRegistrableDomain("https://help.acme.co.nz/x")).toBe("acme.co.nz");
    expect(toRegistrableDomain("https://acme.co.za")).toBe("acme.co.za");
  });

  it("keeps project and docs hosts apart, including the ones the review added", () => {
    // Each of these is a suffix under which one tenant is one publisher.
    // Collapsing any of them would put every customer of that platform into a
    // single leaderboard row that dwarfs every real domain.
    expect(toRegistrableDomain("https://acme.vercel.app/x")).toBe("acme.vercel.app");
    expect(toRegistrableDomain("https://acme.netlify.app/x")).toBe("acme.netlify.app");
    expect(toRegistrableDomain("https://acme.pages.dev/x")).toBe("acme.pages.dev");
    expect(toRegistrableDomain("https://acme.workers.dev/x")).toBe("acme.workers.dev");
    expect(toRegistrableDomain("https://acme.herokuapp.com/x")).toBe("acme.herokuapp.com");
    expect(toRegistrableDomain("https://acme.web.app/x")).toBe("acme.web.app");
    expect(toRegistrableDomain("https://acme.firebaseapp.com/x")).toBe("acme.firebaseapp.com");
    expect(toRegistrableDomain("https://acme.gitlab.io/x")).toBe("acme.gitlab.io");
    expect(toRegistrableDomain("https://acme.notion.site/page")).toBe("acme.notion.site");
    expect(toRegistrableDomain("https://someone.substack.com/p/post")).toBe("someone.substack.com");
    expect(toRegistrableDomain("https://team.gitbook.io/docs")).toBe("team.gitbook.io");
    expect(toRegistrableDomain("https://proj.readthedocs.io/en/latest/")).toBe(
      "proj.readthedocs.io"
    );
  });

  it("normalises the host: case, ports, userinfo, trailing dots and IDN", () => {
    expect(toRegistrableDomain("https://ACME.CO.UK./x")).toBe("acme.co.uk");
    expect(toRegistrableDomain("https://acme.com:8443/x")).toBe("acme.com");
    expect(toRegistrableDomain("acme.com:8443")).toBe("acme.com");
    expect(toRegistrableDomain("https://user:pw@blog.acme.com/x")).toBe("acme.com");
    expect(toRegistrableDomain("https://acme.com.")).toBe("acme.com");
    expect(toRegistrableDomain("  https://acme.com/x  ")).toBe("acme.com");
    // WHATWG URL punycodes a unicode host, so the two spellings of one site
    // reduce to one row rather than two.
    expect(toRegistrableDomain("https://münchen.de/x")).toBe("xn--mnchen-3ya.de");
    expect(toRegistrableDomain("https://xn--mnchen-3ya.de/x")).toBe("xn--mnchen-3ya.de");
  });

  it("passes an IP literal through, v4 and bracketed v6 alike", () => {
    expect(toRegistrableDomain("http://10.0.0.1:8080/x")).toBe("10.0.0.1");
    expect(toRegistrableDomain("https://[2001:db8::1]/x")).toBe("[2001:db8::1]");
  });

  it("accepts a non-http scheme and a single-label host", () => {
    expect(toRegistrableDomain("ftp://files.acme.com/x")).toBe("acme.com");
    expect(toRegistrableDomain("localhost")).toBe("localhost");
  });

  it("collapses an unlisted multi-part suffix — the documented known limitation", () => {
    // Recorded so it is not rediscovered as a bug: the suffix table is a
    // hand-maintained subset, so a suffix that is not in it reduces to its last
    // two labels and every site under it merges into one row. Pulling in `psl`
    // or `tldts` is the fix if this ever bites.
    expect(toRegistrableDomain("https://acme.co.example/x")).toBe("co.example");
    expect(toRegistrableDomain("https://rival.co.example/x")).toBe("co.example");
  });
});

describe("isRedirector", () => {
  it("matches the Gemini grounding host whatever its case", () => {
    expect(isRedirector("https://vertexaisearch.cloud.google.com/grounding-api-redirect/A")).toBe(
      true
    );
    expect(isRedirector("https://VERTEXAISEARCH.CLOUD.GOOGLE.COM/x")).toBe(true);
  });

  it("is false for anything that is not that exact host, and never throws", () => {
    expect(isRedirector("https://cloud.google.com/x")).toBe(false);
    expect(isRedirector("https://evil.example/vertexaisearch.cloud.google.com")).toBe(false);
    // Deliberately parsed strictly: a scheme-less string is not a URL here, and
    // guessing one would mean firing a request at a host we did not resolve.
    expect(isRedirector("vertexaisearch.cloud.google.com/x")).toBe(false);
    expect(isRedirector("not a url")).toBe(false);
    expect(isRedirector("")).toBe(false);
  });
});

describe("resolveRedirect, the hop mechanics", () => {
  const HANDLE = "https://vertexaisearch.cloud.google.com/grounding-api-redirect";

  it("asks with GET and manual redirects, so the Location header is readable", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://acme.com/x" } })
    );

    await resolveRedirect(`${HANDLE}/A`, fetchImpl as never);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
  });

  it("bounds every hop at five seconds", async () => {
    // The value matters, not just its presence: a run resolves hundreds of
    // these, and without a ceiling each hung redirector inherits the runtime's
    // ~300s headers timeout and stalls the slice past its budget.
    const spy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://acme.com/x" } })
    );

    await resolveRedirect(`${HANDLE}/A`, fetchImpl as never);

    expect(spy).toHaveBeenCalledWith(5_000);
    spy.mockRestore();
  });

  it("follows a chain of redirectors all the way to the real page", async () => {
    const chain: Record<string, string> = {
      [`${HANDLE}/A`]: `${HANDLE}/B`,
      [`${HANDLE}/B`]: `${HANDLE}/C`,
      [`${HANDLE}/C`]: "https://acme.com/pricing",
    };
    const fetchImpl = vi.fn(
      async (url: string) =>
        new Response(null, { status: 302, headers: { location: chain[url] ?? "https://x.example" } })
    );

    expect(await resolveRedirect(`${HANDLE}/A`, fetchImpl as never)).toBe("https://acme.com/pricing");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("gives up after the hop budget on a chain of distinct redirectors", async () => {
    // Not a self-loop — every hop is a NEW redirector, so the loop guard does
    // not fire and only the hop ceiling stops it.
    let n = 0;
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: `${HANDLE}/${++n}` } })
    );

    const resolved = await resolveRedirect(`${HANDLE}/A`, fetchImpl as never);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Unresolved, but still a URL: stored under the redirector's own domain,
    // which is visibly wrong on the leaderboard rather than silently missing.
    expect(resolved.startsWith(HANDLE)).toBe(true);
  });

  it("keeps the handle when the Location header cannot be parsed", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "http://[bad" } })
    );

    expect(await resolveRedirect(`${HANDLE}/A`, fetchImpl as never)).toBe(`${HANDLE}/A`);
  });

  it("takes the final URL off the response when the runtime followed the chain itself", async () => {
    const followed = new Response("", { status: 200 });
    Object.defineProperty(followed, "url", { value: "https://acme.com/pricing" });
    const fetchImpl = vi.fn(async () => followed);

    expect(await resolveRedirect(`${HANDLE}/A`, fetchImpl as never)).toBe(
      "https://acme.com/pricing"
    );
  });
});

describe("classifyDomain, precedence and the tail-matched families", () => {
  it("puts a tracked brand ahead of whatever else its domain looks like", () => {
    // A tenant whose site IS a community or docs host is still `own`; a
    // competitor on one is still `competitor`. Otherwise the leaderboard would
    // file the tenant's own citations under "community".
    expect(classifyDomain("github.com", { ownDomain: "github.com", competitorDomains: [] })).toBe(
      "own"
    );
    expect(classifyDomain("medium.com", { ownDomain: null, competitorDomains: ["medium.com"] })).toBe(
      "competitor"
    );
    expect(
      classifyDomain("g2.com", { ownDomain: "acme.com", competitorDomains: ["g2.com"] })
    ).toBe("competitor");
  });

  it("compares both sides trimmed and lowercased, and ignores blank competitors", () => {
    expect(
      classifyDomain("  ACME.COM  ", { ownDomain: " Acme.Com ", competitorDomains: [] })
    ).toBe("own");
    expect(classifyDomain("g2.com", { ownDomain: null, competitorDomains: ["", "   "] })).toBe(
      "review"
    );
    expect(classifyDomain("   ", { ownDomain: "acme.com", competitorDomains: [] })).toBe("other");
  });

  it("classifies a subdomain by its family for every bucket", () => {
    const none = { ownDomain: null, competitorDomains: [] };
    expect(classifyDomain("www.g2.com", none)).toBe("review");
    expect(classifyDomain("blog.medium.com", none)).toBe("community");
    expect(classifyDomain("team.gitbook.io", none)).toBe("docs");
    expect(classifyDomain("halo.fandom.com", none)).toBe("wiki");
    expect(classifyDomain("eu.techcrunch.com", none)).toBe("publisher");
  });

  it("does not let a lookalike label borrow a family", () => {
    const none = { ownDomain: null, competitorDomains: [] };
    // Tail matching compares the last TWO labels, so neither a prefixed name
    // nor a different suffix can inherit a family it has nothing to do with.
    expect(classifyDomain("notreddit.com", none)).toBe("other");
    expect(classifyDomain("g2.com.example", none)).toBe("other");
    expect(classifyDomain("reddit.example", none)).toBe("other");
  });
});
