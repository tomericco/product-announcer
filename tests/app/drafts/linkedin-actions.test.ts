import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, releases } from "../../../src/db/schema";

vi.mock("../../../src/lib/workspace/session", () => ({ requireSession: vi.fn() }));
vi.mock("../../../src/lib/ai/linkedin-copy", () => ({ generateLinkedinCopy: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { requireSession } from "../../../src/lib/workspace/session";
import { generateLinkedinCopy } from "../../../src/lib/ai/linkedin-copy";
import { generateLinkedinCopyAction, saveLinkedinCopyAction } from "../../../src/app/(dashboard)/drafts/[releaseId]/linkedin-actions";

const TENANT = "LinkedIn Drafts Actions Test Tenant";

async function seedRelease() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const [release] = await db
    .insert(releases)
    .values({ tenantId: tenant.id, title: "T", body: "B", status: "draft" })
    .returning();
  return { tenantId: tenant.id, releaseId: release.id };
}

function fd(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe("linkedin draft actions", () => {
  beforeEach(() => {
    vi.mocked(requireSession).mockReset();
    vi.mocked(generateLinkedinCopy).mockReset();
  });
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("generates and stores copy, clearing the edited marker", async () => {
    const { tenantId, releaseId } = await seedRelease();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId } } as never);
    vi.mocked(generateLinkedinCopy).mockResolvedValue("Generated post.");
    await generateLinkedinCopyAction(fd({ releaseId }));
    const [row] = await db.select().from(releases).where(eq(releases.id, releaseId));
    expect(row.linkedinBody).toBe("Generated post.");
    expect(row.linkedinBodyEditedAt).toBeNull();
  });

  it("saves hand-edited copy and stamps the edited marker", async () => {
    const { tenantId, releaseId } = await seedRelease();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId } } as never);
    await saveLinkedinCopyAction(fd({ releaseId, linkedinBody: "My edit." }));
    const [row] = await db.select().from(releases).where(eq(releases.id, releaseId));
    expect(row.linkedinBody).toBe("My edit.");
    expect(row.linkedinBodyEditedAt).not.toBeNull();
  });

  it("refuses to touch a release from another tenant", async () => {
    const { releaseId } = await seedRelease();
    vi.mocked(requireSession).mockResolvedValue({ user: { tenantId: "00000000-0000-0000-0000-000000000000" } } as never);
    await saveLinkedinCopyAction(fd({ releaseId, linkedinBody: "x" }));
    const [row] = await db.select().from(releases).where(eq(releases.id, releaseId));
    expect(row.linkedinBody).toBeNull();
  });
});
