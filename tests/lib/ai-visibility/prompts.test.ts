import { describe, it, expect, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  competitors,
  aiVisibilityPrompts,
  aiVisibilityRuns,
  aiVisibilitySamples,
  sources,
  users,
} from "../../../src/db/schema";
import {
  MAX_ACTIVE_PROMPTS,
  MAX_PROMPT_CHARS,
  listPrompts,
  getPrompt,
  countActivePrompts,
  createPrompt,
  approveProposals,
  pausePrompt,
  resumePrompt,
  editPrompt,
  deletePrompt,
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

  it("rethrows a failure that is not a duplicate, rather than blaming the wording", async () => {
    const tenant = await seedTenant(TENANT);
    const [a] = await seedProposals(tenant.id, ["prompt a"]);

    // A foreign-key violation (23503), not a unique one: `approvedBy` names a
    // user that does not exist. Reporting this as "duplicate" would send the
    // reviewer off to edit wording that was never the problem.
    await expect(
      approveProposals(tenant.id, {
        approveIds: [a],
        rejectIds: [],
        approvedBy: "00000000-0000-4000-8000-000000000000",
      })
    ).rejects.toThrow();

    const [untouched] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, a));
    expect(untouched.status).toBe("proposed");
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

async function seedSample(tenantId: string, promptId: string) {
  const [source] = await db
    .insert(sources)
    .values({ tenantId, type: "ai_visibility", url: null, label: "AI visibility" })
    .returning();
  const [run] = await db
    .insert(aiVisibilityRuns)
    .values({ tenantId, sourceId: source.id, trigger: "manual", engines: ["openai"], samplesPerPrompt: 3 })
    .returning();
  await db
    .insert(aiVisibilitySamples)
    .values({ runId: run.id, tenantId, promptId, engine: "openai", sampleIndex: 0 });
}

describe("pausePrompt / resumePrompt", () => {
  it("pauses an active prompt and frees a cap slot, then resumes it", async () => {
    const tenant = await seedTenant(TENANT);
    const created = await createPrompt(tenant.id, { text: "best issue trackers", intent: "discovery" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await pausePrompt(tenant.id, created.prompt.id)).toEqual({ ok: true });
    expect(await countActivePrompts(tenant.id)).toBe(0);
    const [paused] = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.id, created.prompt.id));
    expect(paused.status).toBe("paused");
    expect(paused.pausedAt).not.toBeNull();

    expect(await resumePrompt(tenant.id, created.prompt.id)).toEqual({ ok: true });
    const [resumed] = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.id, created.prompt.id));
    expect(resumed.status).toBe("active");
    expect(resumed.pausedAt).toBeNull();
  });

  it("refuses to resume past the cap, and refuses an id from another tenant", async () => {
    const tenant = await seedTenant(TENANT);
    const created = await createPrompt(tenant.id, { text: "the paused one", intent: "discovery" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await pausePrompt(tenant.id, created.prompt.id);
    await fillActive(tenant.id, MAX_ACTIVE_PROMPTS);

    expect(await resumePrompt(tenant.id, created.prompt.id)).toEqual({ ok: false, error: "cap" });

    const other = await seedTenant(`${TENANT} Two`);
    try {
      expect(await pausePrompt(other.id, created.prompt.id)).toEqual({ ok: false, error: "not_found" });
    } finally {
      await dropTenant(`${TENANT} Two`);
    }
  });
});

describe("editPrompt", () => {
  it("creates a new prompt pointing at the old one and pauses the old one", async () => {
    const tenant = await seedTenant(TENANT);
    const created = await createPrompt(tenant.id, {
      text: "best issue trackers",
      intent: "comparison",
      persona: "Head of Engineering",
      cluster: "us_vs_them",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const edited = await editPrompt(tenant.id, created.prompt.id, "best issue trackers for seed-stage teams");

    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.prompt.id).not.toBe(created.prompt.id);
    expect(edited.prompt.supersedesId).toBe(created.prompt.id);
    expect(edited.prompt.status).toBe("active");
    // Everything but the wording carries over.
    expect(edited.prompt.intent).toBe("comparison");
    expect(edited.prompt.persona).toBe("Head of Engineering");
    expect(edited.prompt.cluster).toBe("us_vs_them");
    expect(edited.prompt.origin).toBe("user");

    const [old] = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.id, created.prompt.id));
    expect(old.status).toBe("paused");
    expect(old.text).toBe("best issue trackers");
    expect(await countActivePrompts(tenant.id)).toBe(1);
  });

  it("carries the flag over — a rewrite is not a re-judgement", async () => {
    const tenant = await seedTenant(TENANT);
    const created = await createPrompt(tenant.id, {
      text: "issue trackers for teams",
      intent: "discovery",
      flagReason: "Reads like a search keyword, not something a buyer would type into a chatbot.",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const edited = await editPrompt(tenant.id, created.prompt.id, "issue trackers for engineering teams");

    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.prompt.flagReason).toBe(created.prompt.flagReason);
  });

  it("is a no-op when the wording did not actually change", async () => {
    const tenant = await seedTenant(TENANT);
    const created = await createPrompt(tenant.id, { text: "best issue trackers", intent: "discovery" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const edited = await editPrompt(tenant.id, created.prompt.id, "  best issue   trackers ");

    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.prompt.id).toBe(created.prompt.id);
    expect(
      await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.tenantId, tenant.id))
    ).toHaveLength(1);
  });

  it("refuses unusable text, a wording already in use, and a proposal", async () => {
    const tenant = await seedTenant(TENANT);
    const a = await createPrompt(tenant.id, { text: "prompt a", intent: "discovery" });
    const b = await createPrompt(tenant.id, { text: "prompt b", intent: "discovery" });
    const proposal = await createPrompt(tenant.id, {
      text: "a proposal",
      intent: "discovery",
      status: "proposed",
    });
    expect(a.ok && b.ok && proposal.ok).toBe(true);
    if (!a.ok || !b.ok || !proposal.ok) return;

    expect(await editPrompt(tenant.id, a.prompt.id, "no")).toEqual({ ok: false, error: "invalid" });
    expect(await editPrompt(tenant.id, a.prompt.id, "prompt b")).toEqual({ ok: false, error: "duplicate" });
    // Proposals are edited in place by approveProposals, never superseded.
    expect(await editPrompt(tenant.id, proposal.prompt.id, "a better proposal")).toEqual({
      ok: false,
      error: "not_found",
    });

    const [untouched] = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.id, a.prompt.id));
    expect(untouched.status).toBe("active");
  });
});

describe("deletePrompt", () => {
  it("deletes a prompt nothing has ever run against", async () => {
    const tenant = await seedTenant(TENANT);
    const created = await createPrompt(tenant.id, { text: "never run", intent: "discovery" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await deletePrompt(tenant.id, created.prompt.id)).toEqual({ ok: true });
    expect(
      await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, created.prompt.id))
    ).toHaveLength(0);
  });

  it("refuses once a sample exists, and refuses an id from another tenant", async () => {
    const tenant = await seedTenant(TENANT);
    const created = await createPrompt(tenant.id, { text: "has history", intent: "discovery" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await seedSample(tenant.id, created.prompt.id);

    expect(await deletePrompt(tenant.id, created.prompt.id)).toEqual({ ok: false, error: "has_samples" });

    const other = await seedTenant(`${TENANT} Two`);
    try {
      expect(await deletePrompt(other.id, created.prompt.id)).toEqual({ ok: false, error: "not_found" });
    } finally {
      await dropTenant(`${TENANT} Two`);
    }
  });
});

// ---------------------------------------------------------------------------
// Coverage added in QA review of Phase B. Everything below tests a rule the
// plan or the spec states but the first pass asserted only obliquely — the
// exact cap boundaries, the partial-unique index's rejected-row semantics,
// tenant isolation on the functions that did not have it, and the one
// transaction whose atomicity needed a fault-injection seam.
// ---------------------------------------------------------------------------

/**
 * A `db` whose transactions run for real but whose `tx.update` throws, so the
 * failure lands BETWEEN `editPrompt`'s insert and its pause of the
 * predecessor — the one interleaving the transaction exists to prevent.
 *
 * Same proxy shape as `dbWithFailingInsert` in
 * `tests/lib/signals/competitor-agent.test.ts`. `Reflect.get(target, prop,
 * target)` plus `.bind(target)` keeps every un-intercepted call running
 * against the real transaction object rather than through the proxy, which
 * matters because drizzle's builders close over the session.
 */
function dbWithFailingTransactionUpdate(): typeof db {
  const proxyDb = Object.assign(Object.create(Object.getPrototypeOf(db)), db) as typeof db;
  const failingTransaction = (fn: (tx: unknown) => unknown) =>
    db.transaction((tx) =>
      Promise.resolve(
        fn(
          new Proxy(tx as unknown as object, {
            get(target, prop) {
              if (prop === "update") {
                return () => {
                  throw new Error("simulated pause failure");
                };
              }
              const value = Reflect.get(target, prop, target);
              return typeof value === "function"
                ? (value as (...args: unknown[]) => unknown).bind(target)
                : value;
            },
          })
        )
      )
    );
  proxyDb.transaction = failingTransaction as unknown as typeof db.transaction;
  return proxyDb;
}

describe("normalizePromptText — the edges of the length window", () => {
  it("accepts exactly the boundary lengths and rejects one past each", () => {
    expect(normalizePromptText("abc")).toBe("abc");
    expect(normalizePromptText("ab")).toBeNull();
    expect(normalizePromptText("x".repeat(MAX_PROMPT_CHARS))).toHaveLength(MAX_PROMPT_CHARS);
    expect(normalizePromptText("x".repeat(MAX_PROMPT_CHARS + 1))).toBeNull();
  });

  it("collapses first and measures second, so whitespace cannot push a prompt over the limit", () => {
    const words = Array.from({ length: 100 }, () => "ab");
    words[99] = "abc";
    const collapsed = words.join(" ");
    const spaced = words.join("   ");
    expect(collapsed).toHaveLength(MAX_PROMPT_CHARS);
    expect(spaced.length).toBeGreaterThan(MAX_PROMPT_CHARS);

    // Exactly at the limit once collapsed, well over it before — the order of
    // the two operations is the whole test.
    expect(normalizePromptText(spaced)).toBe(collapsed);
  });

  it("collapses every kind of whitespace, not just the space bar", () => {
    expect(normalizePromptText("best\tissue\r\n\ntrackers")).toBe("best issue trackers");
    expect(normalizePromptText(" best issue trackers ")).toBe("best issue trackers");
  });

  it("leaves casing alone — two spellings are two prompts", () => {
    // Documenting the rule, not endorsing it: the unique index is on the
    // stored text, so "Best issue trackers" and "best issue trackers" are two
    // separate rows with two separate histories.
    expect(normalizePromptText("Best Issue Trackers")).toBe("Best Issue Trackers");
  });

  it("rejects what is not a string at all", () => {
    expect(normalizePromptText(null)).toBeNull();
    expect(normalizePromptText(undefined)).toBeNull();
    expect(normalizePromptText({ text: "best issue trackers" })).toBeNull();
    expect(normalizePromptText(["best issue trackers"])).toBeNull();
  });
});

describe("the 30-active cap, at the boundary on every path", () => {
  it("lets createPrompt fill the last slot and refuses only the one after it", async () => {
    const tenant = await seedTenant(TENANT);
    await fillActive(tenant.id, MAX_ACTIVE_PROMPTS - 1);
    expect(await countActivePrompts(tenant.id)).toBe(MAX_ACTIVE_PROMPTS - 1);

    const thirtieth = await createPrompt(tenant.id, { text: "the thirtieth prompt", intent: "discovery" });
    expect(thirtieth.ok).toBe(true);
    expect(await countActivePrompts(tenant.id)).toBe(MAX_ACTIVE_PROMPTS);

    expect(await createPrompt(tenant.id, { text: "the thirty-first prompt", intent: "discovery" })).toEqual({
      ok: false,
      error: "cap",
    });
    expect(await countActivePrompts(tenant.id)).toBe(MAX_ACTIVE_PROMPTS);
  });

  it("lets approveProposals fill the set exactly, and refuses the batch one over", async () => {
    const tenant = await seedTenant(TENANT);
    await fillActive(tenant.id, MAX_ACTIVE_PROMPTS - 2);
    const exact = await seedProposals(tenant.id, ["prompt a", "prompt b"]);

    expect(await approveProposals(tenant.id, { approveIds: exact, rejectIds: [] })).toEqual({
      ok: true,
      approved: 2,
      rejected: 0,
    });
    expect(await countActivePrompts(tenant.id)).toBe(MAX_ACTIVE_PROMPTS);

    const overflow = await seedProposals(tenant.id, ["prompt c"]);
    expect(await approveProposals(tenant.id, { approveIds: overflow, rejectIds: [] })).toEqual({
      ok: false,
      error: "cap",
      available: 0,
      requested: 1,
    });
    expect(await countActivePrompts(tenant.id)).toBe(MAX_ACTIVE_PROMPTS);
  });

  it("lets resumePrompt take the last slot and refuses the next one", async () => {
    const tenant = await seedTenant(TENANT);
    const first = await createPrompt(tenant.id, { text: "the first paused one", intent: "discovery" });
    const second = await createPrompt(tenant.id, { text: "the second paused one", intent: "discovery" });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    await pausePrompt(tenant.id, first.prompt.id);
    await pausePrompt(tenant.id, second.prompt.id);
    await fillActive(tenant.id, MAX_ACTIVE_PROMPTS - 1);

    expect(await resumePrompt(tenant.id, first.prompt.id)).toEqual({ ok: true });
    expect(await countActivePrompts(tenant.id)).toBe(MAX_ACTIVE_PROMPTS);
    expect(await resumePrompt(tenant.id, second.prompt.id)).toEqual({ ok: false, error: "cap" });
    expect(await countActivePrompts(tenant.id)).toBe(MAX_ACTIVE_PROMPTS);
  });

  it("lets editPrompt through at a full cap — a supersede is net zero, not a 31st prompt", async () => {
    const tenant = await seedTenant(TENANT);
    await fillActive(tenant.id, MAX_ACTIVE_PROMPTS);
    const [victim] = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(and(eq(aiVisibilityPrompts.tenantId, tenant.id), eq(aiVisibilityPrompts.status, "active")))
      .limit(1);

    const edited = await editPrompt(tenant.id, victim.id, "a reworded prompt at a full cap");

    // Refusing here would leave a tenant at the cap unable to fix a typo, and
    // the new row replaces the old one rather than joining it.
    expect(edited.ok).toBe(true);
    expect(await countActivePrompts(tenant.id)).toBe(MAX_ACTIVE_PROMPTS);
  });

  it("counts only this tenant's active prompts", async () => {
    const tenant = await seedTenant(TENANT);
    await fillActive(tenant.id, 3);

    const other = await seedTenant(`${TENANT} Two`);
    try {
      await createPrompt(other.id, { text: "best issue trackers for team 0", intent: "discovery" });
      expect(await countActivePrompts(other.id)).toBe(1);
      expect(await countActivePrompts(tenant.id)).toBe(3);
    } finally {
      await dropTenant(`${TENANT} Two`);
    }
  });
});

describe("the partial unique index", () => {
  it("lets a rejected wording be written again — negatives must not block the prompt set", async () => {
    const tenant = await seedTenant(TENANT);
    await db.insert(aiVisibilityPrompts).values({
      tenantId: tenant.id,
      text: "best issue trackers",
      intent: "discovery",
      origin: "generated",
      status: "rejected",
    });

    const again = await createPrompt(tenant.id, { text: "best issue trackers", intent: "discovery" });

    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.prompt.status).toBe("active");
    // Both rows survive: the rejection is still a negative for the next
    // generation, and the active prompt is the one that runs.
    expect(
      await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.tenantId, tenant.id))
    ).toHaveLength(2);
  });

  it("lets the same wording be turned down more than once", async () => {
    const tenant = await seedTenant(TENANT);
    const twice = Array.from({ length: 2 }, () => ({
      tenantId: tenant.id,
      text: "a wording they keep turning down",
      intent: "discovery",
      origin: "generated" as const,
      status: "rejected" as const,
    }));

    // Two rejections of the same suggestion must not collide with each other,
    // or the second review of a regenerated set would throw.
    await db.insert(aiVisibilityPrompts).values(twice);

    expect(
      await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.tenantId, tenant.id))
    ).toHaveLength(2);
  });

  it("is scoped to one tenant — two workspaces may ask the same question", async () => {
    const tenant = await seedTenant(TENANT);
    await createPrompt(tenant.id, { text: "best issue trackers", intent: "discovery" });

    const other = await seedTenant(`${TENANT} Two`);
    try {
      const mine = await createPrompt(other.id, { text: "best issue trackers", intent: "discovery" });
      expect(mine.ok).toBe(true);
    } finally {
      await dropTenant(`${TENANT} Two`);
    }
  });
});

describe("approveProposals — the rest of the batch contract", () => {
  it("approves an id that arrives in both lists, rather than rejecting it", async () => {
    const tenant = await seedTenant(TENANT);
    const [a] = await seedProposals(tenant.id, ["prompt a"]);

    const result = await approveProposals(tenant.id, { approveIds: [a], rejectIds: [a] });

    expect(result).toEqual({ ok: true, approved: 1, rejected: 0 });
    const [row] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, a));
    expect(row.status).toBe("active");
  });

  it("counts a repeated id once against the cap", async () => {
    const tenant = await seedTenant(TENANT);
    await fillActive(tenant.id, MAX_ACTIVE_PROMPTS - 1);
    const [a] = await seedProposals(tenant.id, ["prompt a"]);

    // Three copies of the same id are one prompt, not three: de-duplicating
    // after the cap check would bounce a batch that fits.
    const result = await approveProposals(tenant.id, { approveIds: [a, a, a], rejectIds: [] });

    expect(result).toEqual({ ok: true, approved: 1, rejected: 0 });
    expect(await countActivePrompts(tenant.id)).toBe(MAX_ACTIVE_PROMPTS);
  });

  it("charges the cap only for the rows still awaiting review in a half-stale batch", async () => {
    const tenant = await seedTenant(TENANT);
    await fillActive(tenant.id, MAX_ACTIVE_PROMPTS - 1);
    const [alreadyActive] = await db
      .select({ id: aiVisibilityPrompts.id })
      .from(aiVisibilityPrompts)
      .where(and(eq(aiVisibilityPrompts.tenantId, tenant.id), eq(aiVisibilityPrompts.status, "active")))
      .limit(1);
    const [fresh] = await seedProposals(tenant.id, ["prompt a"]);

    // Two ids, one free slot. Counting the whole batch would report a cap
    // error for a review that fits perfectly well.
    const result = await approveProposals(tenant.id, {
      approveIds: [alreadyActive.id, fresh],
      rejectIds: [],
    });

    expect(result).toEqual({ ok: true, approved: 1, rejected: 0 });
    expect(await countActivePrompts(tenant.id)).toBe(MAX_ACTIVE_PROMPTS);
  });

  it("stores the exclusions as rejected negatives with their wording intact", async () => {
    const tenant = await seedTenant(TENANT);
    const [a, b] = await seedProposals(tenant.id, ["prompt a", "prompt b"]);

    await approveProposals(tenant.id, { approveIds: [a], rejectIds: [b] });

    const [negative] = await db.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.id, b));
    // Kept, not deleted: `generatePromptSet` reads these back as negatives.
    expect(negative.status).toBe("rejected");
    expect(negative.text).toBe("prompt b");
    expect(negative.approvedAt).toBeNull();
    expect(await countActivePrompts(tenant.id)).toBe(1);
  });

  it("refuses an edit onto the wording of a row being rejected in the SAME batch", async () => {
    const tenant = await seedTenant(TENANT);
    const [a, b] = await seedProposals(tenant.id, ["prompt a", "prompt b"]);

    // The reviewer's move: two near-duplicate suggestions, uncheck one, retype
    // the better wording onto the one they are keeping.
    const result = await approveProposals(tenant.id, {
      approveIds: [a],
      rejectIds: [b],
      edits: [{ promptId: a, text: "prompt b" }],
    });

    // Pinning today's behaviour, which is arguably wrong: the edits run before
    // the rejections inside the transaction, so `b` is still `proposed` — and
    // so still covered by the partial unique index — when the edit lands.
    // After the batch commits it would have been `rejected` and out of the
    // index. Rejecting first inside the transaction would let this through.
    // Reported, not fixed: this file does not touch production code.
    expect(result).toEqual({ ok: false, error: "duplicate" });
    const rows = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.tenantId, tenant.id));
    expect(rows.every((row) => row.status === "proposed")).toBe(true);
  });

  it("cannot reach another tenant's proposals", async () => {
    const tenant = await seedTenant(TENANT);
    const [a, b] = await seedProposals(tenant.id, ["prompt a", "prompt b"]);

    const other = await seedTenant(`${TENANT} Two`);
    try {
      const result = await approveProposals(other.id, { approveIds: [a], rejectIds: [b] });
      expect(result).toEqual({ ok: true, approved: 0, rejected: 0 });
    } finally {
      await dropTenant(`${TENANT} Two`);
    }

    const rows = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.tenantId, tenant.id));
    expect(rows.every((row) => row.status === "proposed")).toBe(true);
  });
});

describe("pausePrompt / resumePrompt — the statuses that must not move", () => {
  it("refuses to pause anything that is not active", async () => {
    const tenant = await seedTenant(TENANT);
    const proposal = await createPrompt(tenant.id, {
      text: "a proposal",
      intent: "discovery",
      status: "proposed",
    });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    const [rejected] = await db
      .insert(aiVisibilityPrompts)
      .values({
        tenantId: tenant.id,
        text: "a rejected one",
        intent: "discovery",
        origin: "generated",
        status: "rejected",
      })
      .returning();

    expect(await pausePrompt(tenant.id, proposal.prompt.id)).toEqual({ ok: false, error: "not_found" });
    expect(await pausePrompt(tenant.id, rejected.id)).toEqual({ ok: false, error: "not_found" });
  });

  it("refuses to resume anything that is not paused", async () => {
    const tenant = await seedTenant(TENANT);
    const active = await createPrompt(tenant.id, { text: "an active one", intent: "discovery" });
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    const [rejected] = await db
      .insert(aiVisibilityPrompts)
      .values({
        tenantId: tenant.id,
        text: "a rejected one",
        intent: "discovery",
        origin: "generated",
        status: "rejected",
      })
      .returning();

    // A stale toggle must not resurrect a turned-down suggestion into the run
    // set, and must not re-stamp an already-active prompt.
    expect(await resumePrompt(tenant.id, active.prompt.id)).toEqual({ ok: false, error: "not_found" });
    expect(await resumePrompt(tenant.id, rejected.id)).toEqual({ ok: false, error: "not_found" });

    const other = await seedTenant(`${TENANT} Two`);
    try {
      await pausePrompt(tenant.id, active.prompt.id);
      expect(await resumePrompt(other.id, active.prompt.id)).toEqual({ ok: false, error: "not_found" });
    } finally {
      await dropTenant(`${TENANT} Two`);
    }
  });
});

describe("editPrompt — the rest of the supersede contract", () => {
  it("supersedes a paused prompt without putting either wording back in the run set", async () => {
    const tenant = await seedTenant(TENANT);
    const created = await createPrompt(tenant.id, { text: "the old wording", intent: "discovery" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await pausePrompt(tenant.id, created.prompt.id);

    const edited = await editPrompt(tenant.id, created.prompt.id, "the new wording");

    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.prompt.status).toBe("paused");
    expect(edited.prompt.pausedAt).not.toBeNull();
    expect(edited.prompt.supersedesId).toBe(created.prompt.id);
    // Editing a paused prompt must not quietly re-activate it past the cap.
    expect(await countActivePrompts(tenant.id)).toBe(0);
  });

  it("links both directions through getPrompt after a real edit", async () => {
    const tenant = await seedTenant(TENANT);
    const created = await createPrompt(tenant.id, { text: "the old wording", intent: "discovery" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const edited = await editPrompt(tenant.id, created.prompt.id, "the new wording");
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    const predecessor = await getPrompt(tenant.id, created.prompt.id);
    expect(predecessor?.supersedesId).toBeNull();
    expect(predecessor?.supersededById).toBe(edited.prompt.id);

    const successor = await getPrompt(tenant.id, edited.prompt.id);
    expect(successor?.supersedesId).toBe(created.prompt.id);
    expect(successor?.supersededById).toBeNull();
  });

  it("may reuse a wording that exists only as a rejected negative", async () => {
    const tenant = await seedTenant(TENANT);
    await db.insert(aiVisibilityPrompts).values({
      tenantId: tenant.id,
      text: "a wording they turned down",
      intent: "discovery",
      origin: "generated",
      status: "rejected",
    });
    const created = await createPrompt(tenant.id, { text: "the old wording", intent: "discovery" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const edited = await editPrompt(tenant.id, created.prompt.id, "a wording they turned down");

    expect(edited.ok).toBe(true);
  });

  it("cannot edit another tenant's prompt", async () => {
    const tenant = await seedTenant(TENANT);
    const created = await createPrompt(tenant.id, { text: "the old wording", intent: "discovery" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const other = await seedTenant(`${TENANT} Two`);
    try {
      expect(await editPrompt(other.id, created.prompt.id, "the new wording")).toEqual({
        ok: false,
        error: "not_found",
      });
    } finally {
      await dropTenant(`${TENANT} Two`);
    }

    const rows = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
  });

  it("leaves nothing behind when the pause fails after the successor is inserted", async () => {
    const tenant = await seedTenant(TENANT);
    const created = await createPrompt(tenant.id, { text: "the old wording", intent: "discovery" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await expect(
      editPrompt(tenant.id, created.prompt.id, "the new wording", dbWithFailingTransactionUpdate())
    ).rejects.toThrow(/simulated pause failure/);

    // The state the transaction exists to prevent: successor inserted, old row
    // never paused, both wordings active and the tenant one over the cap.
    const rows = await db
      .select()
      .from(aiVisibilityPrompts)
      .where(eq(aiVisibilityPrompts.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(created.prompt.id);
    expect(rows[0].text).toBe("the old wording");
    expect(rows[0].status).toBe("active");
    expect(await countActivePrompts(tenant.id)).toBe(1);
  });
});
