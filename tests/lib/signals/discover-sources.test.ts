import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, competitors, sources } from "../../../src/db/schema";
import { discoverCompetitorSources } from "../../../src/lib/signals/discover-sources";
import type { PageResult } from "../../../src/lib/workspace/fetch-page";

const TENANT = "Discover Sources Test Tenant";
const LONG = "x".repeat(300);

const page = (html: string, finalUrl: string): PageResult => ({
  text: `content ${LONG}`,
  html,
  finalUrl,
  contentType: "text/html",
});

function fakeFetcher(pages: Record<string, PageResult>) {
  const calls: string[] = [];
  return {
    calls,
    fetchPage: async (url: string): Promise<PageResult> => {
      calls.push(url);
      return pages[url] ?? { error: "fetch-failed" };
    },
  };
}

async function seed() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const [rival] = await db
    .insert(competitors)
    .values({ tenantId: tenant.id, name: "Rival", websiteUrl: "https://rival.com" })
    .returning();
  return { tenant, rival };
}

describe("discoverCompetitorSources", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("proposes changelog and blog pages linked from the homepage", async () => {
    const { tenant, rival } = await seed();
    const { fetchPage } = fakeFetcher({
      "https://rival.com": page(
        `<a href="/changelog">Changelog</a><a href="/blog">Blog</a><a href="/careers">Careers</a>`,
        "https://rival.com"
      ),
      "https://rival.com/changelog": page("<html></html>", "https://rival.com/changelog"),
      "https://rival.com/blog": page("<html></html>", "https://rival.com/blog"),
    });

    const created = await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", { fetchPage });

    expect(created.map((s) => s.url).sort()).toEqual([
      "https://rival.com/blog",
      "https://rival.com/changelog",
    ]);
    expect(created.every((s) => s.type === "competitor_web")).toBe(true);
    expect(created.every((s) => s.competitorId === rival.id)).toBe(true);
  });

  it("stores the agent-facing variant when the competitor publishes one", async () => {
    const { tenant, rival } = await seed();
    const md: PageResult = {
      text: `# Changelog ${LONG}`,
      html: `# Changelog ${LONG}`,
      finalUrl: "https://rival.com/changelog.md",
      contentType: "text/markdown",
    };
    const { fetchPage } = fakeFetcher({
      "https://rival.com": page(`<a href="/changelog">Changelog</a>`, "https://rival.com"),
      "https://rival.com/changelog": page("<html></html>", "https://rival.com/changelog"),
      "https://rival.com/changelog.md": md,
    });

    const [source] = await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", { fetchPage });
    expect(source.url).toBe("https://rival.com/changelog");
    expect(source.agentUrl).toBe("https://rival.com/changelog.md");
  });

  it("leaves agentUrl null when nothing agent-facing is published", async () => {
    const { tenant, rival } = await seed();
    const { fetchPage } = fakeFetcher({
      "https://rival.com": page(`<a href="/changelog">Changelog</a>`, "https://rival.com"),
      "https://rival.com/changelog": page("<html></html>", "https://rival.com/changelog"),
    });

    const [source] = await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", { fetchPage });
    expect(source.agentUrl).toBeNull();
  });

  it("backfills agentUrl on re-discovery, and does not clear it when a later probe finds nothing", async () => {
    const { tenant, rival } = await seed();
    const withMd = {
      "https://rival.com": page(`<a href="/changelog">Changelog</a>`, "https://rival.com"),
      "https://rival.com/changelog": page("<html></html>", "https://rival.com/changelog"),
      "https://rival.com/changelog.md": {
        text: `# Changelog ${LONG}`,
        html: `# Changelog ${LONG}`,
        finalUrl: "https://rival.com/changelog.md",
        contentType: "text/markdown",
      } as PageResult,
    };
    const withoutMd = {
      "https://rival.com": page(`<a href="/changelog">Changelog</a>`, "https://rival.com"),
      "https://rival.com/changelog": page("<html></html>", "https://rival.com/changelog"),
    };

    // First discovery finds no agent page.
    await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", {
      fetchPage: fakeFetcher(withoutMd).fetchPage,
    });
    // The competitor publishes one; re-discovery picks it up.
    await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", {
      fetchPage: fakeFetcher(withMd).fetchPage,
    });
    let rows = await db.select().from(sources).where(eq(sources.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].agentUrl).toBe("https://rival.com/changelog.md");

    // A later probe failing must not throw the mapping away.
    await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", {
      fetchPage: fakeFetcher(withoutMd).fetchPage,
    });
    rows = await db.select().from(sources).where(eq(sources.tenantId, tenant.id));
    expect(rows[0].agentUrl).toBe("https://rival.com/changelog.md");
  });

  it("matches path SEGMENTS, so an article under /blog is not mistaken for the blog index", async () => {
    const { tenant, rival } = await seed();
    const { fetchPage, calls } = fakeFetcher({
      "https://rival.com": page(`<a href="/blog/why-we-left-jira">A post</a>`, "https://rival.com"),
    });

    const created = await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", { fetchPage });
    expect(created).toEqual([]);
    expect(calls).toEqual(["https://rival.com"]);
  });

  it("creates at most three sources", async () => {
    const { tenant, rival } = await seed();
    const paths = ["/changelog", "/blog", "/news", "/releases", "/updates"];
    const pages: Record<string, PageResult> = {
      "https://rival.com": page(paths.map((p) => `<a href="${p}">${p}</a>`).join(""), "https://rival.com"),
    };
    for (const p of paths) pages[`https://rival.com${p}`] = page("<html></html>", `https://rival.com${p}`);

    const created = await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", {
      fetchPage: fakeFetcher(pages).fetchPage,
    });
    expect(created).toHaveLength(3);
  });

  it("is idempotent — a second run creates no duplicates", async () => {
    const { tenant, rival } = await seed();
    const pages = {
      "https://rival.com": page(`<a href="/changelog">Changelog</a>`, "https://rival.com"),
      "https://rival.com/changelog": page("<html></html>", "https://rival.com/changelog"),
    };
    const deps = { fetchPage: fakeFetcher(pages).fetchPage };

    await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", deps);
    await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", deps);

    const rows = await db.select().from(sources).where(eq(sources.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
  });

  it("writes nothing when the homepage cannot be fetched", async () => {
    const { tenant, rival } = await seed();
    const created = await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", {
      fetchPage: fakeFetcher({}).fetchPage,
    });

    expect(created).toEqual([]);
    expect(await db.select().from(sources).where(eq(sources.tenantId, tenant.id))).toHaveLength(0);
  });

  it("routes every request through the injected fetcher — no bare fetch", async () => {
    const { tenant, rival } = await seed();
    const { fetchPage, calls } = fakeFetcher({
      "https://rival.com": page(`<a href="/changelog">Changelog</a>`, "https://rival.com"),
      "https://rival.com/changelog": page("<html></html>", "https://rival.com/changelog"),
    });

    await discoverCompetitorSources(tenant.id, rival.id, "https://rival.com", { fetchPage });
    expect(calls.every((c) => c.startsWith("https://rival.com"))).toBe(true);
    expect(calls[0]).toBe("https://rival.com");
  });
});
