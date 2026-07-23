import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn() }));

import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, repos, changeEvents, atomicUpdates } from "../../../src/db/schema";
import {
  regenerateAtomicSummary,
  refreshAtomicUpdates,
} from "../../../src/lib/ai/regenerate-atomic-summary";

const TENANT = "Regenerate Summary Test Tenant";

async function seedRepo(tenantId: string) {
  const [repo] = await db
    .insert(repos)
    .values({
      tenantId,
      githubRepoFullName: "acme/widgets",
      githubInstallationId: "1",
      watchedBranch: "main",
    })
    .returning();
  return repo;
}

async function insertEvent(tenantId: string, repoId: string, atomicUpdateId: string, sha: string) {
  const [row] = await db
    .insert(changeEvents)
    .values({
      tenantId,
      repoId,
      type: "commit",
      provider: "github",
      externalId: sha,
      commitSha: sha,
      commitMessage: sha,
      atomicUpdateId,
    })
    .returning();
  return row;
}

describe("regenerateAtomicSummary", () => {
  afterEach(() => vi.mocked(generateObject).mockReset());

  it("returns the regenerated title, summary, and size", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "CSV export", summary: "Export reports as CSV, now with headers.", size: "m" },
      usage: {},
    } as never);

    const result = await regenerateAtomicSummary({
      tenantId: "t1",
      current: { title: "CSV export", summary: "Export reports as CSV." },
      evidence: [{ type: "commit", title: "add headers to csv", summary: "Adds a header row." }],
    });

    expect(result).toEqual({
      title: "CSV export",
      summary: "Export reports as CSV, now with headers.",
      size: "m",
    });
  });

  it("returns null on model error", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("boom"));

    const result = await regenerateAtomicSummary({
      tenantId: "t1",
      current: { title: "T", summary: "S" },
      evidence: [{ type: "commit", title: "x", summary: null }],
    });

    expect(result).toBeNull();
  });
});

describe("refreshAtomicUpdates", () => {
  afterEach(async () => {
    vi.mocked(generateObject).mockReset();
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("case (a): neither frozen — rewrites title/summary AND size", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Old", summary: "Old summary.", size: "s" })
      .returning();
    await insertEvent(tenant.id, repo.id, atomic.id, "sha-rewrite-a");

    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T2", summary: "S2", size: "l" },
      usage: {},
    } as never);

    await refreshAtomicUpdates(db, tenant.id, [atomic.id]);

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.title).toBe("T2");
    expect(after.summary).toBe("S2");
    expect(after.size).toBe("l");
  });

  it("case (b): summaryEditedAt set, sizeEditedAt null — size updated, title/summary unchanged", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({
        tenantId: tenant.id,
        title: "Old",
        summary: "Old summary.",
        size: "s",
        summaryEditedAt: new Date(),
      })
      .returning();
    await insertEvent(tenant.id, repo.id, atomic.id, "sha-rewrite-b");

    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T2", summary: "S2", size: "l" },
      usage: {},
    } as never);

    await refreshAtomicUpdates(db, tenant.id, [atomic.id]);

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.title).toBe("Old");
    expect(after.summary).toBe("Old summary.");
    expect(after.size).toBe("l");
  });

  it("case (c): sizeEditedAt set, summaryEditedAt null — title/summary updated, size unchanged", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({
        tenantId: tenant.id,
        title: "Old",
        summary: "Old summary.",
        size: "s",
        sizeEditedAt: new Date(),
      })
      .returning();
    await insertEvent(tenant.id, repo.id, atomic.id, "sha-rewrite-c");

    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T2", summary: "S2", size: "l" },
      usage: {},
    } as never);

    await refreshAtomicUpdates(db, tenant.id, [atomic.id]);

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.title).toBe("T2");
    expect(after.summary).toBe("S2");
    expect(after.size).toBe("s");
  });

  it("leaves a released atomic update untouched and does not call the model", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Old", summary: "Old summary.", status: "released" })
      .returning();
    await insertEvent(tenant.id, repo.id, atomic.id, "sha-released");

    await refreshAtomicUpdates(db, tenant.id, [atomic.id]);

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.title).toBe("Old");
    expect(after.summary).toBe("Old summary.");
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("leaves an atomic update with no attached change events untouched", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Old", summary: "Old summary." })
      .returning();

    await refreshAtomicUpdates(db, tenant.id, [atomic.id]);

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.title).toBe("Old");
    expect(after.summary).toBe("Old summary.");
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("case (d): both frozen — nothing changes and the model is not called", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({
        tenantId: tenant.id,
        title: "Hand written",
        summary: "Hand written summary.",
        size: "s",
        summaryEditedAt: new Date(),
        sizeEditedAt: new Date(),
      })
      .returning();

    await refreshAtomicUpdates(db, tenant.id, [atomic.id]);

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.title).toBe("Hand written");
    expect(after.summary).toBe("Hand written summary.");
    expect(after.size).toBe("s");
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("keeps the hand-edited summary when the user edits mid-flight, discarding the model's stale output", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const repo = await seedRepo(tenant.id);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Old", summary: "Old summary." })
      .returning();
    await insertEvent(tenant.id, repo.id, atomic.id, "sha-race");

    // Hold the model call open so we can inject the mid-flight edit before it
    // resolves. The resolver is captured externally rather than resolved
    // immediately, so we control exactly when the "model response" arrives.
    let resolveGenerate!: (value: unknown) => void;
    const held = new Promise((resolve) => {
      resolveGenerate = resolve;
    });
    vi.mocked(generateObject).mockImplementation(() => held as never);

    const refreshPromise = refreshAtomicUpdates(db, tenant.id, [atomic.id]);

    // Wait until the mocked call has actually been entered, proving the
    // SELECT (which found the row unedited) has already happened.
    await vi.waitFor(() => {
      expect(generateObject).toHaveBeenCalled();
    });

    // While the model call is still pending, simulate the user hitting save.
    await db
      .update(atomicUpdates)
      .set({ summary: "Hand-edited mid-flight.", summaryEditedAt: new Date() })
      .where(eq(atomicUpdates.id, atomic.id));

    // Now let the model "respond".
    resolveGenerate({
      object: { title: "Model title", summary: "Model summary.", size: "l" },
      usage: {},
    });

    await refreshPromise;

    const [after] = await db.select().from(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    expect(after.summary).toBe("Hand-edited mid-flight.");
    expect(after.summary).not.toBe("Model summary.");
  });
});
