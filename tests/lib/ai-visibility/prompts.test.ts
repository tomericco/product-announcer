import { describe, it, expect, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { competitors, aiVisibilityPrompts, users } from "../../../src/db/schema";
import {
  MAX_ACTIVE_PROMPTS,
  listPrompts,
  getPrompt,
  countActivePrompts,
  createPrompt,
  approveProposals,
  normalizePromptText,
} from "../../../src/lib/ai-visibility/prompts";
import { seedTenant, dropTenant } from "../../helpers/fixtures";

const TENANT = "AI Visibility Prompts Test Tenant";
/** `users` is not tenant-scoped, so `dropTenant` does not reach it. */
const PROMPTS_USER_EMAIL = "ai-visibility-prompts@example.test";

afterEach(async () => {
  await dropTenant(TENANT);
  await db.delete(users).where(eq(users.email, PROMPTS_USER_EMAIL));
});

async function fillActive(tenantId: string, howMany: number) {
  for (let i = 0; i < howMany; i++) {
    const result = await createPrompt(tenantId, {
      text: `best issue trackers for team ${i}`,
      intent: "discovery",
      origin: "generated",
      status: "active",
    });
    expect(result.ok).toBe(true);
  }
}

describe("normalizePromptText", () => {
  it("collapses whitespace and rejects what is not a prompt", () => {
    expect(normalizePromptText("  best   issue \n trackers ")).toBe("best issue trackers");
    expect(normalizePromptText("hi")).toBeNull();
    expect(normalizePromptText("   ")).toBeNull();
    expect(normalizePromptText(42)).toBeNull();
    expect(normalizePromptText("x".repeat(301))).toBeNull();
  });
});

describe("createPrompt", () => {
  it("defaults to an active, user-origin prompt and stamps approvedAt", async () => {
    const tenant = await seedTenant(TENANT);

    const result = await createPrompt(tenant.id, { text: "best issue trackers", intent: "discovery" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt.status).toBe("active");
    expect(result.prompt.origin).toBe("user");
    expect(result.prompt.approvedAt).not.toBeNull();
  });

  it("leaves a proposal unapproved and uncounted", async () => {
    const tenant = await seedTenant(TENANT);

    const result = await createPrompt(tenant.id, {
      text: "best issue trackers",
      intent: "discovery",
      origin: "generated",
      status: "proposed",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt.approvedAt).toBeNull();
    expect(await countActivePrompts(tenant.id)).toBe(0);
  });

  it("refuses a duplicate wording rather than throwing on the index", async () => {
    const tenant = await seedTenant(TENANT);
    await createPrompt(tenant.id, { text: "best issue trackers", intent: "discovery" });

    const again = await createPrompt(tenant.id, { text: "  best  issue trackers ", intent: "comparison" });

    expect(again).toEqual({ ok: false, error: "duplicate" });
  });

  it("refuses an unusable text or an intent we do not have", async () => {
    const tenant = await seedTenant(TENANT);

    expect(await createPrompt(tenant.id, { text: "no", intent: "discovery" })).toEqual({
      ok: false,
      error: "invalid",
    });
    expect(
      await createPrompt(tenant.id, { text: "best issue trackers", intent: "sentiment" as never })
    ).toEqual({ ok: false, error: "invalid" });
  });

  it("stops at 30 active prompts, but still accepts proposals past the cap", async () => {
    const tenant = await seedTenant(TENANT);
    await fillActive(tenant.id, MAX_ACTIVE_PROMPTS);

    expect(await countActivePrompts(tenant.id)).toBe(MAX_ACTIVE_PROMPTS);
    expect(await createPrompt(tenant.id, { text: "one too many", intent: "discovery" })).toEqual({
      ok: false,
      error: "cap",
    });
    const proposal = await createPrompt(tenant.id, {
      text: "one too many",
      intent: "discovery",
      status: "proposed",
    });
    expect(proposal.ok).toBe(true);
  });

  it("does not count paused or rejected prompts against the cap", async () => {
    const tenant = await seedTenant(TENANT);
    await createPrompt(tenant.id, { text: "an active one", intent: "discovery" });
    await db.insert(aiVisibilityPrompts).values([
      { tenantId: tenant.id, text: "a paused one", intent: "discovery", origin: "user", status: "paused" },
      { tenantId: tenant.id, text: "a rejected one", intent: "discovery", origin: "generated", status: "rejected" },
    ]);

    expect(await countActivePrompts(tenant.id)).toBe(1);
  });
});

describe("listPrompts", () => {
  it("filters by status, intent, persona and competitor, and stays tenant-scoped", async () => {
    const tenant = await seedTenant(TENANT);
    const [rival] = await db
      .insert(competitors)
      .values({ tenantId: tenant.id, name: "Rival" })
      .returning();
    await createPrompt(tenant.id, {
      text: "best issue trackers for eng leads",
      intent: "discovery",
      persona: "Head of Engineering",
    });
    await createPrompt(tenant.id, {
      text: "acme vs rival",
      intent: "comparison",
      competitorId: rival.id,
    });
    await createPrompt(tenant.id, {
      text: "a paused comparison",
      intent: "comparison",
      status: "proposed",
    });

    expect(await listPrompts(tenant.id)).toHaveLength(3);
    expect(await listPrompts(tenant.id, { status: "active" })).toHaveLength(2);
    expect(await listPrompts(tenant.id, { status: ["proposed"] })).toHaveLength(1);
    expect(await listPrompts(tenant.id, { intent: "comparison" })).toHaveLength(2);
    expect(await listPrompts(tenant.id, { persona: "Head of Engineering" })).toHaveLength(1);
    expect(await listPrompts(tenant.id, { competitorId: rival.id })).toHaveLength(1);
    expect(await listPrompts(tenant.id, { status: [] })).toHaveLength(0);

    const other = await seedTenant(`${TENANT} Two`);
    try {
      expect(await listPrompts(other.id)).toHaveLength(0);
    } finally {
      await dropTenant(`${TENANT} Two`);
    }
  });

  it("returns prompts oldest first, deterministically", async () => {
    const tenant = await seedTenant(TENANT);
    await createPrompt(tenant.id, { text: "first", intent: "discovery" });
    await createPrompt(tenant.id, { text: "second", intent: "discovery" });
    await createPrompt(tenant.id, { text: "third", intent: "discovery" });

    const texts = (await listPrompts(tenant.id)).map((p) => p.text);
    expect(texts).toEqual(["first", "second", "third"]);
  });
});

describe("getPrompt", () => {
  it("returns one prompt with both directions of its supersede link", async () => {
    const tenant = await seedTenant(TENANT);
    const original = await createPrompt(tenant.id, { text: "the old wording", intent: "discovery" });
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    const [replacement] = await db
      .insert(aiVisibilityPrompts)
      .values({
        tenantId: tenant.id,
        text: "the new wording",
        intent: "discovery",
        origin: "user",
        status: "active",
        supersedesId: original.prompt.id,
        flagReason: "Reads like a search keyword, not something a buyer would type into a chatbot.",
      })
      .returning();

    const old = await getPrompt(tenant.id, original.prompt.id);
    expect(old?.supersedesId).toBeNull();
    expect(old?.supersededById).toBe(replacement.id);

    const current = await getPrompt(tenant.id, replacement.id);
    expect(current?.supersedesId).toBe(original.prompt.id);
    expect(current?.supersededById).toBeNull();
    expect(current?.flagReason).toMatch(/keyword/i);
  });

  it("returns null for a prompt that does not exist and for one that is not ours", async () => {
    const tenant = await seedTenant(TENANT);
    const created = await createPrompt(tenant.id, { text: "ours", intent: "discovery" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await getPrompt(tenant.id, "00000000-0000-4000-8000-000000000000")).toBeNull();

    const other = await seedTenant(`${TENANT} Two`);
    try {
      expect(await getPrompt(other.id, created.prompt.id)).toBeNull();
    } finally {
      await dropTenant(`${TENANT} Two`);
    }
  });
});

async function seedProposals(tenantId: string, texts: string[]) {
  const ids: string[] = [];
  for (const text of texts) {
    const result = await createPrompt(tenantId, { text, intent: "discovery", origin: "generated", status: "proposed" });
    expect(result.ok).toBe(true);
    if (result.ok) ids.push(result.prompt.id);
  }
  return ids;
}

describe("approveProposals", () => {
  it("activates the checked rows and keeps the unchecked ones as negatives", async () => {
    const tenant = await seedTenant(TENANT);
    const [user] = await db.insert(users).values({ email: PROMPTS_USER_EMAIL, name: "Reviewer" }).returning();
    const [a, b, c] = await seedProposals(tenant.id, ["prompt a", "prompt b", "prompt c"]);

    const result = await approveProposals(tenant.id, {
      approveIds: [a, b],
      rejectIds: [c],
      approvedBy: user.id,
    });

    expect(result).toEqual({ ok: true, approved: 2, rejected: 1 });
    expect(await countActivePrompts(tenant.id)).toBe(2);
    const [rejected] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, c));
    expect(rejected.status).toBe("rejected");
    const [approved] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, a));
    expect(approved.approvedBy).toBe(user.id);
    expect(approved.approvedAt).not.toBeNull();
  });

  it("applies an inline edit in place — a proposal has no history to protect", async () => {
    const tenant = await seedTenant(TENANT);
    const [a, b] = await seedProposals(tenant.id, ["prompt a", "prompt b"]);

    const result = await approveProposals(tenant.id, {
      approveIds: [a, b],
      rejectIds: [],
      edits: [{ promptId: a, text: "  best issue trackers for   seed-stage teams " }],
    });

    expect(result).toEqual({ ok: true, approved: 2, rejected: 0 });
    const [edited] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, a));
    expect(edited.text).toBe("best issue trackers for seed-stage teams");
    expect(edited.status).toBe("active");
    expect(edited.supersedesId).toBeNull();
    const rows = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.tenantId, tenant.id));
    expect(rows).toHaveLength(2);
  });

  it("ignores an edit to a row the reviewer then unchecked", async () => {
    const tenant = await seedTenant(TENANT);
    const [a, b] = await seedProposals(tenant.id, ["prompt a", "prompt b"]);

    await approveProposals(tenant.id, {
      approveIds: [a],
      rejectIds: [b],
      edits: [{ promptId: b, text: "an edit nobody asked to keep" }],
    });

    const [untouched] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, b));
    expect(untouched.text).toBe("prompt b");
    expect(untouched.status).toBe("rejected");
  });

  it("writes nothing at all when an edit is unusable or collides", async () => {
    const tenant = await seedTenant(TENANT);
    await createPrompt(tenant.id, { text: "an existing active prompt", intent: "discovery" });
    const [a, b] = await seedProposals(tenant.id, ["prompt a", "prompt b"]);

    expect(
      await approveProposals(tenant.id, { approveIds: [a, b], rejectIds: [], edits: [{ promptId: a, text: "no" }] })
    ).toEqual({ ok: false, error: "invalid" });
    expect(
      await approveProposals(tenant.id, {
        approveIds: [a, b],
        rejectIds: [],
        edits: [{ promptId: a, text: "an existing active prompt" }],
      })
    ).toEqual({ ok: false, error: "duplicate" });

    expect(await countActivePrompts(tenant.id)).toBe(1);
    const [still] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, a));
    expect(still.status).toBe("proposed");
    expect(still.text).toBe("prompt a");
  });

  it("rolls the whole batch back when a later edit collides — no partial state survives", async () => {
    const tenant = await seedTenant(TENANT);
    await createPrompt(tenant.id, { text: "an existing active prompt", intent: "discovery" });
    const [a, b] = await seedProposals(tenant.id, ["prompt a", "prompt b"]);

    const result = await approveProposals(tenant.id, {
      approveIds: [a, b],
      rejectIds: [],
      edits: [
        { promptId: a, text: "a perfectly fine rewording" },
        // The second edit hits the partial unique index after the first has
        // already been applied inside the transaction.
        { promptId: b, text: "an existing active prompt" },
      ],
    });

    expect(result).toEqual({ ok: false, error: "duplicate" });
    const [first] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, a));
    expect(first.text).toBe("prompt a");
    expect(first.status).toBe("proposed");
    const [second] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, b));
    expect(second.text).toBe("prompt b");
    expect(second.status).toBe("proposed");
    expect(await countActivePrompts(tenant.id)).toBe(1);
  });

  it("no-ops a replayed approve form even at the cap, instead of a spurious cap error", async () => {
    const tenant = await seedTenant(TENANT);
    await fillActive(tenant.id, MAX_ACTIVE_PROMPTS);
    const [alreadyActive] = await db
      .select({ id: aiVisibilityPrompts.id })
      .from(aiVisibilityPrompts)
      .where(and(eq(aiVisibilityPrompts.tenantId, tenant.id), eq(aiVisibilityPrompts.status, "active")))
      .limit(1);

    const result = await approveProposals(tenant.id, { approveIds: [alreadyActive.id], rejectIds: [] });

    expect(result).toEqual({ ok: true, approved: 0, rejected: 0 });
    expect(await countActivePrompts(tenant.id)).toBe(MAX_ACTIVE_PROMPTS);
  });

  it("refuses the whole batch when it would breach the cap, and says by how much", async () => {
    const tenant = await seedTenant(TENANT);
    await fillActive(tenant.id, MAX_ACTIVE_PROMPTS - 1);
    const ids = await seedProposals(tenant.id, ["prompt a", "prompt b", "prompt c"]);

    const result = await approveProposals(tenant.id, { approveIds: ids, rejectIds: [] });

    expect(result).toEqual({ ok: false, error: "cap", available: 1, requested: 3 });
    expect(await countActivePrompts(tenant.id)).toBe(MAX_ACTIVE_PROMPTS - 1);
  });

  it("touches only this tenant's proposals, and only rows still `proposed`", async () => {
    const tenant = await seedTenant(TENANT);
    const [a] = await seedProposals(tenant.id, ["prompt a"]);
    const active = await createPrompt(tenant.id, { text: "already active", intent: "discovery" });
    expect(active.ok).toBe(true);
    const activeId = active.ok ? active.prompt.id : "";

    const first = await approveProposals(tenant.id, { approveIds: [a, activeId], rejectIds: [] });
    expect(first).toEqual({ ok: true, approved: 1, rejected: 0 });

    // Re-running the same batch is a no-op, not a second approval.
    const second = await approveProposals(tenant.id, { approveIds: [a], rejectIds: [] });
    expect(second).toEqual({ ok: true, approved: 0, rejected: 0 });
  });
});
