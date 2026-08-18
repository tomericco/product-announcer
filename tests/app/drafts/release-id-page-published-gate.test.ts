import { describe, it, expect, afterEach, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces } from "../../../src/db/schema";

// Same technique as tests/app/briefs-new-page.test.ts: call the async Server
// Component directly and inspect the returned element tree — no
// testing-library, no DOM. Nested Client/Server Components (ToastForm,
// PublishDialog, ...) referenced in JSX are NOT executed by this — a
// component reference only becomes `{type: Foo, props: ...}` until React
// actually renders it, so `.type` identity comparisons below tell us what
// WOULD have been rendered without needing to render it.
let currentTenantId = "";

vi.mock("../../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: null } })),
}));

import DraftDetailPage from "../../../src/app/(dashboard)/drafts/[releaseId]/page";
import { SaveChangesButton, RejectButton } from "../../../src/app/(dashboard)/drafts/[releaseId]/draft-submit-buttons";
import { PublishDialog } from "../../../src/app/(dashboard)/drafts/[releaseId]/publish-dialog";
import { ToastForm } from "../../../src/app/(dashboard)/settings/toast-form";

const TENANT = "Draft Page Published-Gate Test Tenant";

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
      title: "A piece",
      body: "Original body",
      status: "draft",
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

// Recursively searches the (unexecuted) element tree for any node whose
// `.type` is the given component reference.
function containsType(node: ReactNode, target: unknown): boolean {
  if (node === null || node === undefined || typeof node === "boolean") return false;
  if (typeof node === "string" || typeof node === "number") return false;
  if (Array.isArray(node)) return node.some((n) => containsType(n, target));
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === target) return true;
  return containsType(el.props?.children, target);
}

describe("DraftDetailPage — published-piece gate", () => {
  it("a published piece renders read-only: no ToastForm, PublishDialog, Save, or Reject anywhere in the tree", async () => {
    const { piece } = await seed({ status: "published", publishedAt: new Date("2026-09-12T09:00:00Z") });

    const page = (await DraftDetailPage({
      params: Promise.resolve({ releaseId: piece.id }),
    })) as ReactElement;

    expect(containsType(page, ToastForm)).toBe(false);
    expect(containsType(page, PublishDialog)).toBe(false);
    expect(containsType(page, SaveChangesButton)).toBe(false);
    expect(containsType(page, RejectButton)).toBe(false);

    // Still viewable — per the finding, "keep it readable".
    expect(textOf(page)).toContain("A piece");
    expect(textOf(page)).toContain("Original body");
    expect(textOf(page).toLowerCase()).toContain("already been published");
  });

  it("a draft piece (unchanged behaviour) still renders the full editable form", async () => {
    const { piece } = await seed({ status: "draft" });

    const page = (await DraftDetailPage({
      params: Promise.resolve({ releaseId: piece.id }),
    })) as ReactElement;

    // Regression guard: the published gate must not over-block a normal,
    // still-editable draft.
    expect(containsType(page, ToastForm)).toBe(true);
    expect(containsType(page, PublishDialog)).toBe(true);
    expect(containsType(page, SaveChangesButton)).toBe(true);
    expect(containsType(page, RejectButton)).toBe(true);
  });
});
