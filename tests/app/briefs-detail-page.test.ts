import { describe, it, expect, afterEach, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, briefs } from "../../src/db/schema";

// Same technique as tests/app/drafts/release-id-page-published-gate.test.ts:
// call the async Server Component directly and inspect the element tree it
// returns. Nested Client Components referenced in JSX are NOT executed — a
// component reference is only `{ type: Foo, props }` until React renders it —
// so `.type` identity tells us what WOULD render without rendering it.
let currentTenantId = "";

vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: null } })),
}));

import BriefDetailPage from "../../src/app/(dashboard)/briefs/[briefId]/page";
import { BriefWorkspace } from "../../src/app/(dashboard)/briefs/[briefId]/brief-workspace";
import { renderBriefBody } from "../../src/lib/briefs/body";

const TENANT = "Brief Detail Page Test Tenant";
const OTHER_TENANT = "Brief Detail Page Other Tenant";

afterEach(async () => {
  vi.clearAllMocks();
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  await db.delete(tenants).where(eq(tenants.name, OTHER_TENANT));
});

async function seed(overrides: Partial<typeof briefs.$inferInsert> = {}, tenantName = TENANT) {
  const [tenant] = await db.insert(tenants).values({ name: tenantName }).returning();
  const [brief] = await db
    .insert(briefs)
    .values({
      tenantId: tenant.id,
      origin: "agent",
      contentType: "blog_post",
      title: "How localization breaks design systems",
      angle: "Most teams discover it too late",
      whyNow: "Two competitors shipped multilingual tooling this month",
      suggestedChannel: "blog",
      keyPoints: ["Point one", "Point two"],
      audience: "Design system owners",
      score: 0.8,
      lastEvidenceAt: new Date(),
      ...overrides,
    })
    .returning();
  currentTenantId = tenant.id;
  return { tenant, brief };
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return textOf(el.props?.children);
}

function containsType(node: ReactNode, target: unknown): boolean {
  if (node === null || node === undefined || typeof node === "boolean") return false;
  if (typeof node === "string" || typeof node === "number") return false;
  if (Array.isArray(node)) return node.some((n) => containsType(n, target));
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === target) return true;
  return containsType(el.props?.children, target);
}

/** Finds the props the page would render `BriefWorkspace` with. */
function editorProps(node: ReactNode): { initialTitle: string; initialBody: string } | null {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = editorProps(child);
      if (found) return found;
    }
    return null;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === BriefWorkspace) return el.props as unknown as { initialTitle: string; initialBody: string };
  return editorProps(el.props?.children);
}

describe("BriefDetailPage", () => {
  it("seeds the editor from the stored body once one exists", async () => {
    const { brief } = await seed({ body: "## Angle\nA human rewrote this." });

    const page = (await BriefDetailPage({ params: Promise.resolve({ briefId: brief.id }) })) as ReactElement;

    expect(containsType(page, BriefWorkspace)).toBe(true);
    expect(editorProps(page)?.initialBody).toBe("## Angle\nA human rewrote this.");
    expect(editorProps(page)?.initialTitle).toBe("How localization breaks design systems");
  });

  it("falls back to the rendered fields for a brief created before the body column", async () => {
    const { brief } = await seed({ body: null });

    const page = (await BriefDetailPage({ params: Promise.resolve({ briefId: brief.id }) })) as ReactElement;

    // Byte-identical to what `renderBriefBody` produces — the fallback IS the
    // renderer, so the editor opens on exactly the document the brief would
    // have been seeded with at creation.
    expect(editorProps(page)?.initialBody).toBe(renderBriefBody(brief));
  });
});

// The spec: "A dismissed or accepted brief opens read-only." Editing a brief
// whose draft has already been generated would silently diverge the two.
describe("BriefDetailPage read-only gate", () => {
  it("an accepted brief renders read-only — no editor and no decision header", async () => {
    const { brief } = await seed({ status: "accepted", body: "## Angle\nThe accepted commission." });

    const page = (await BriefDetailPage({ params: Promise.resolve({ briefId: brief.id }) })) as ReactElement;

    expect(containsType(page, BriefWorkspace)).toBe(false);
    // Still readable, per the drafts editor's published branch.
    expect(textOf(page)).toContain("The accepted commission.");
    expect(textOf(page)).toContain("How localization breaks design systems");
  });

  it("a dismissed brief renders read-only — no editor and no decision header", async () => {
    const { brief } = await seed({ status: "dismissed", body: "## Angle\nThe dismissed commission." });

    const page = (await BriefDetailPage({ params: Promise.resolve({ briefId: brief.id }) })) as ReactElement;

    expect(containsType(page, BriefWorkspace)).toBe(false);
    expect(textOf(page)).toContain("The dismissed commission.");
  });

  it("a new brief still renders the editor, so the gate does not over-block", async () => {
    const { brief } = await seed({ status: "new" });

    const page = (await BriefDetailPage({ params: Promise.resolve({ briefId: brief.id }) })) as ReactElement;

    expect(containsType(page, BriefWorkspace)).toBe(true);
  });
});

// The id comes from the URL and is untrusted. A brief carries a company's
// unpublished content strategy, so this is a membership check, not a
// convenience — and a 404 rather than a "not yours", which would confirm the
// brief exists.
describe("BriefDetailPage tenant scoping", () => {
  it("404s on another tenant's brief", async () => {
    const { brief } = await seed({ body: "## Angle\nThe victim's commission." }, OTHER_TENANT);
    const [attacker] = await db.insert(tenants).values({ name: TENANT }).returning();
    currentTenantId = attacker.id;

    await expect(
      BriefDetailPage({ params: Promise.resolve({ briefId: brief.id }) })
    ).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND/);
  });
});
