import { describe, it, expect, vi } from "vitest";
import { fetchUpdatesPageText, htmlToText } from "../../../src/lib/workspace/scrape-updates-page";

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

describe("fetchUpdatesPageText", () => {
  it("rejects a non-http(s) URL", async () => {
    expect(await fetchUpdatesPageText("ftp://x/y", { fetchImpl: vi.fn() as never })).toEqual({ error: "invalid-url" });
  });

  it("rejects an unparseable URL", async () => {
    expect(await fetchUpdatesPageText("not a url", { fetchImpl: vi.fn() as never })).toEqual({ error: "invalid-url" });
  });

  it("blocks a host that resolves to a private IP", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchUpdatesPageText("https://internal.corp/changelog", {
      fetchImpl: fetchImpl as never,
      resolveHost: async () => ["10.0.0.5"],
    });
    expect(result).toEqual({ error: "blocked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks an IP-literal loopback URL without resolving", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchUpdatesPageText("http://127.0.0.1/x", { fetchImpl: fetchImpl as never })).toEqual({ error: "blocked" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("re-validates redirect hops and blocks a redirect to a private host", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })
    );
    const result = await fetchUpdatesPageText("https://acme.com/changelog", {
      fetchImpl: fetchImpl as never,
      resolveHost: publicResolve,
    });
    expect(result).toEqual({ error: "blocked" });
  });

  it("returns insufficient-content when too little text is extracted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse("<html><body>hi</body></html>"));
    const result = await fetchUpdatesPageText("https://acme.com/changelog", { fetchImpl: fetchImpl as never, resolveHost: publicResolve });
    expect(result).toEqual({ error: "insufficient-content" });
  });

  it("rejects a non-HTML content-type", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const result = await fetchUpdatesPageText("https://acme.com/api", { fetchImpl: fetchImpl as never, resolveHost: publicResolve });
    expect(result).toEqual({ error: "fetch-failed" });
  });

  it("extracts text on success", async () => {
    const body = "<html><body><h1>Changelog</h1>" + "<p>We shipped a great new dashboard and fixed export bugs.</p>".repeat(6) + "</body></html>";
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse(body));
    const result = await fetchUpdatesPageText("https://acme.com/changelog", { fetchImpl: fetchImpl as never, resolveHost: publicResolve });
    expect(result).toHaveProperty("text");
    if ("text" in result) {
      expect(result.text).toContain("Changelog");
      expect(result.text).toContain("dashboard");
    }
  });
});
