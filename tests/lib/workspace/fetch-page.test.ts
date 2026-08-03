import { describe, it, expect, vi } from "vitest";
import { fetchPageText, htmlToText, extractSameOriginLinks } from "../../../src/lib/workspace/fetch-page";

function htmlResponse(body: string, headers: Record<string, string> = {}) {
  return new Response(body, { status: 200, headers: { "content-type": "text/html", ...headers } });
}
const publicResolve = async () => ["93.184.216.34"]; // example.com, public

describe("htmlToText", () => {
  it("strips scripts/styles/tags and collapses whitespace", () => {
    const out = htmlToText("<style>a{}</style><h1>Hi</h1><script>x()</script><p>We&nbsp;shipped &amp; fixed.</p>");
    expect(out).toBe("Hi We shipped & fixed.");
  });
});

describe("fetchPageText", () => {
  it("rejects a non-http(s) URL", async () => {
    expect(await fetchPageText("ftp://x/y", { fetchImpl: vi.fn() as never })).toEqual({ error: "invalid-url" });
  });

  it("rejects an unparseable URL", async () => {
    expect(await fetchPageText("not a url", { fetchImpl: vi.fn() as never })).toEqual({ error: "invalid-url" });
  });

  it("blocks a host that resolves to a private IP", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchPageText("https://internal.corp/changelog", {
      fetchImpl: fetchImpl as never,
      resolveHost: async () => ["10.0.0.5"],
    });
    expect(result).toEqual({ error: "blocked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks an IP-literal loopback URL without resolving", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchPageText("http://127.0.0.1/x", { fetchImpl: fetchImpl as never })).toEqual({ error: "blocked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-validates redirect hops and blocks a redirect to a private host", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })
    );
    const result = await fetchPageText("https://acme.com/changelog", {
      fetchImpl: fetchImpl as never,
      resolveHost: publicResolve,
    });
    expect(result).toEqual({ error: "blocked" });
  });

  it("returns insufficient-content when too little text is extracted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse("<html><body>hi</body></html>"));
    const result = await fetchPageText("https://acme.com/changelog", { fetchImpl: fetchImpl as never, resolveHost: publicResolve });
    expect(result).toEqual({ error: "insufficient-content" });
  });

  it("rejects a non-HTML content-type", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const result = await fetchPageText("https://acme.com/api", { fetchImpl: fetchImpl as never, resolveHost: publicResolve });
    expect(result).toEqual({ error: "fetch-failed" });
  });

  it("extracts text on success", async () => {
    const body = "<html><body><h1>Changelog</h1>" + "<p>We shipped a great new dashboard and fixed export bugs.</p>".repeat(6) + "</body></html>";
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse(body));
    const result = await fetchPageText("https://acme.com/changelog", { fetchImpl: fetchImpl as never, resolveHost: publicResolve });
    expect(result).toHaveProperty("text");
    if ("text" in result) {
      expect(result.text).toContain("Changelog");
      expect(result.text).toContain("dashboard");
    }
  });

  it("blocks an IPv6 loopback literal URL", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchPageText("http://[::1]/x", {
      fetchImpl: fetchImpl as never,
      // `new URL(...).hostname` for a bracketed IPv6 literal is "[::1]", which
      // `net.isIP` does not recognize, so this hits the resolveHost path
      // rather than the isIP fast path. Mock it so the test stays
      // deterministic (no real DNS lookup) while still exercising the
      // isPrivateIp IPv6 branch that must block it.
      resolveHost: async () => ["::1"],
    });
    expect(result).toEqual({ error: "blocked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks an octal-encoded loopback IPv4 literal that new URL normalizes to 127.0.0.1", async () => {
    // Observed behavior (Node 22.17.1): `new URL("http://0177.0.0.1/").hostname`
    // normalizes to "127.0.0.1", so this hits the isIP fast path directly.
    const fetchImpl = vi.fn();
    const result = await fetchPageText("http://0177.0.0.1/", { fetchImpl: fetchImpl as never });
    expect(result).toEqual({ error: "blocked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks a decimal-encoded loopback IPv4 literal that new URL normalizes to 127.0.0.1", async () => {
    // Observed behavior (Node 22.17.1): `new URL("http://2130706433/").hostname`
    // normalizes to "127.0.0.1", so this hits the isIP fast path directly.
    const fetchImpl = vi.fn();
    const result = await fetchPageText("http://2130706433/", { fetchImpl: fetchImpl as never });
    expect(result).toEqual({ error: "blocked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks a host when any resolved IP is private", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchPageText("https://multi-ip.example/changelog", {
      fetchImpl: fetchImpl as never,
      resolveHost: async () => ["93.184.216.34", "10.0.0.5"],
    });
    expect(result).toEqual({ error: "blocked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks a host that DNS-resolves to a private IPv6 address", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchPageText("https://ipv6-internal.example/changelog", {
      fetchImpl: fetchImpl as never,
      resolveHost: async () => ["::1"],
    });
    expect(result).toEqual({ error: "blocked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns fetch-failed (not a throw) when the body stream rejects mid-read", async () => {
    const reader = {
      read: () => Promise.reject(new DOMException("The operation was aborted.", "AbortError")),
      cancel: () => Promise.resolve(),
    };
    const fakeBody = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
    const fakeResponse = {
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      body: fakeBody,
    } as unknown as Response;
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse);
    const result = await fetchPageText("https://acme.com/changelog", { fetchImpl: fetchImpl as never, resolveHost: publicResolve });
    expect(result).toEqual({ error: "fetch-failed" });
  });

  it("caps the body read at MAX_BYTES instead of trusting content-length or fully buffering", async () => {
    // No content-length header is set on this Response, so the fast-path
    // check can't reject it up front; the streaming reader must still cap
    // the read itself and return promptly with truncated text.
    const bigHtml = "<html><body>" + "A".repeat(5_000_000) + "</body></html>";
    const fetchImpl = vi.fn().mockResolvedValue(new Response(bigHtml, { headers: { "content-type": "text/html" } }));
    const result = await fetchPageText("https://acme.com/huge", { fetchImpl: fetchImpl as never, resolveHost: publicResolve });
    expect(result).toHaveProperty("text");
    if ("text" in result) {
      expect(result.text.length).toBeLessThanOrEqual(12_000);
      expect(result.text.length).toBeGreaterThan(0);
    }
  });
});

describe("extractSameOriginLinks", () => {
  const base = "https://example.com/";

  it("returns absolute same-origin URLs, resolving relative hrefs", () => {
    const html = `<a href="/product">P</a><a href="about">A</a><a href="https://example.com/pricing">$</a>`;
    expect(extractSameOriginLinks(html, base)).toEqual([
      "https://example.com/product",
      "https://example.com/about",
      "https://example.com/pricing",
    ]);
  });

  it("drops cross-origin, non-http, and fragment-only links", () => {
    const html = `<a href="https://other.com/x">x</a><a href="mailto:a@b.c">m</a><a href="#top">t</a><a href="javascript:alert(1)">j</a>`;
    expect(extractSameOriginLinks(html, base)).toEqual([]);
  });

  it("deduplicates and ignores the fragment when comparing", () => {
    const html = `<a href="/product">1</a><a href="/product#features">2</a><a href="/product">3</a>`;
    expect(extractSameOriginLinks(html, base)).toEqual(["https://example.com/product"]);
  });

  it("returns an empty array for unparseable base or malformed html", () => {
    expect(extractSameOriginLinks("<a href=", "not a url")).toEqual([]);
  });
});
