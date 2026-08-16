import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement, ReactNode } from "react";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces } from "../../../src/db/schema";

/**
 * The two server-rendered surfaces, checked the way
 * release-id-page-published-gate.test.ts checks its gate: call the async
 * Server Component directly and inspect the element tree it returns. A
 * component referenced in JSX is only `{type: Foo, props}` until React renders
 * it, so `.type` identity tells us what WOULD be mounted without needing a
 * DOM — which is what this file is about. What the badge DOES once mounted is
 * driven in tests/components/generating-badge.test.tsx.
 */

let currentTenantId = "";

vi.mock("../../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: null } })),
}));

import DraftsPage from "../../../src/app/(dashboard)/drafts/page";
import DraftDetailPage from "../../../src/app/(dashboard)/drafts/[releaseId]/page";
import { GenerationChecklist } from "../../../src/components/generation-checklist";
import { GeneratingBadge } from "../../../src/components/generating-badge";

const TENANT = "One Loader In The Modal Test Tenant";

afterEach(async () => {
  vi.clearAllMocks();
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seed(overrides: Partial<typeof contentPieces.$inferInsert> = {}) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const [piece] = await db
    .insert(contentPieces)
    .values({
      tenantId: tenant.id,
      type: "blog_post",
      title: "A piece mid-generation",
      body: "The accept-time scaffold",
      status: "brief",
      ...overrides,
    })
    .returning();
  currentTenantId = tenant.id;
  return { tenant, piece };
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return textOf(el.props?.children);
}

/** Every node in the (unexecuted) tree whose `.type` is `target`. */
function nodesOfType(node: ReactNode, target: unknown): ReactElement[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap((n) => nodesOfType(n, target));
  const el = node as ReactElement<{ children?: ReactNode }>;
  const here = el.type === target ? [el] : [];
  return [...here, ...nodesOfType(el.props?.children, target)];
}

/** Every `.tsx`/`.ts` file under src, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("the checklist has exactly one mount site", () => {
  it("is rendered only by the modal", () => {
    const mounts = sourceFiles(join(process.cwd(), "src"))
      .filter((path) => readFileSync(path, "utf8").includes("<GenerationChecklist"))
      .map((path) => path.slice(process.cwd().length + 1));

    // The whole point of this change: awareness stays on every surface (the
    // badge), but the detail — the stepped loader — lives in one place. A
    // second mount site is how the surfaces drifted apart before.
    expect(mounts).toEqual(["src/components/generation-modal.tsx"]);
  });
});

describe("DraftsPage — the list", () => {
  it("badges a generating row with the control, and mounts no inline checklist", async () => {
    const { piece } = await seed({ generationStep: "generating" });

    const page = (await DraftsPage()) as ReactElement;

    expect(nodesOfType(page, GenerationChecklist)).toHaveLength(0);
    const badges = nodesOfType(page, GeneratingBadge);
    expect(badges).toHaveLength(1);
    expect(badges[0].props).toMatchObject({ contentPieceId: piece.id });
  });

  it("keeps a landed failure's own badge — the control replaces the loader, not the error", async () => {
    await seed({ generationStep: null, generationError: "The model refused." });

    const page = (await DraftsPage()) as ReactElement;

    expect(nodesOfType(page, GeneratingBadge)).toHaveLength(0);
    expect(textOf(page)).toContain("Generation failed");
  });

  it("keeps an un-run brief's own badge", async () => {
    await seed({ generationStep: null, generationError: null });

    const page = (await DraftsPage()) as ReactElement;

    expect(nodesOfType(page, GeneratingBadge)).toHaveLength(0);
    expect(textOf(page)).toContain("Awaiting generation");
  });
});

describe("DraftDetailPage — a brief-status piece", () => {
  it("badges a generating piece with the control, and mounts no inline checklist", async () => {
    const { piece } = await seed({ generationStep: "generating" });

    const page = (await DraftDetailPage({ params: Promise.resolve({ releaseId: piece.id }) })) as ReactElement;

    expect(nodesOfType(page, GenerationChecklist)).toHaveLength(0);
    const badges = nodesOfType(page, GeneratingBadge);
    expect(badges).toHaveLength(1);
    expect(badges[0].props).toMatchObject({ contentPieceId: piece.id });
  });

  it("keeps the landed-failure panel", async () => {
    const { piece } = await seed({ generationStep: null, generationError: "The model refused." });

    const page = (await DraftDetailPage({ params: Promise.resolve({ releaseId: piece.id }) })) as ReactElement;

    expect(nodesOfType(page, GeneratingBadge)).toHaveLength(0);
    expect(textOf(page)).toContain("The last generation attempt failed.");
    expect(textOf(page)).toContain("The model refused.");
  });

  it("keeps the never-generated explanation", async () => {
    const { piece } = await seed({ generationStep: null, generationError: null });

    const page = (await DraftDetailPage({ params: Promise.resolve({ releaseId: piece.id }) })) as ReactElement;

    expect(nodesOfType(page, GeneratingBadge)).toHaveLength(0);
    expect(textOf(page)).toContain("hasn");
    expect(textOf(page)).toContain("Awaiting generation");
  });
});
