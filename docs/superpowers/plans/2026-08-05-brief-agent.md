# Brief Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily per-tenant agent that reads a company's signals and proposes a handful of content briefs — or honestly proposes none.

**Architecture:** One model call per tenant per day. It receives company context, signals from the last 30 days, the briefs currently awaiting a decision, and what has already been accepted or dismissed. It answers with a one-sentence assessment of the period **before** enumerating anything, then returns actions: propose a new brief, or extend an existing one with fresh evidence. Persistence writes `briefs` and the `brief_signals` evidence join. A separate sweep expires briefs nobody acted on.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM + Postgres, AI SDK v7 with `@ai-sdk/anthropic`, Vitest.

## Scope: this is half of spec 5

Spec 5 in the design doc covers `briefs`/`brief_signals`, the agent, expiry, **the inbox UI, and accept→content piece**. This plan is the agent half only — schema through persistence. It ends with briefs in the database, inspectable and verifiable by a live run.

The inbox, the accept flow, and dismissal-as-training-data are a **second plan**. Spec 3 was split the same way (signals layer, then competitor agent) and the split held. Building the UI against briefs that have never been produced by a real run would repeat the mistake this project has already paid for four times.

## Global Constraints

- **This is NOT the Next.js you know.** Next.js 16 with breaking changes from common training data. Read `node_modules/next/dist/docs/` before writing any App Router code.
- Tests run against a **real Postgres database whose name must end in `_test`** (`vitest.setup.ts` hard-fails otherwise); 151 files run **in parallel against one shared database** with no rollback wrapper.
- Tests import by **relative path**, not the `@/` alias (`../../../src/...` from `tests/lib/briefs/`). Source files under `src/` DO use `@/`.
- **There is no shared tenant helper and you must not create one.** Each test file declares a unique tenant-name constant, seeds inline with `db.insert(tenants).values({ name }).returning()`, and cleans up in `afterEach` with `db.delete(tenants).where(eq(tenants.name, TENANT))`.
- **`recordLlmUsage`'s `operation` is a CLOSED string-literal union** in `src/lib/ai/llm-usage.ts`, currently ending at `"news_selection"`. **Task 2 adds `"ideation"` to it.** The DB column is free text, so a missing member fails at `tsc` and never at runtime.
- LLM calls go to **Anthropic directly** via `@ai-sdk/anthropic`. Deliberate and cost-driven — do not route through the Vercel AI Gateway.
- **When a task adds a call to an existing orchestrator, that orchestrator's test is a file to modify.** Task 4 adds a cron step; `tests/app/api/cron/scheduler/route.test.ts` mocks every step because they are unscoped cross-tenant writes, and it **must** gain a mock for the new one. A sweep left unmocked there runs for real against the shared test database and would make paid model calls.
- **The tests are the contract.** If a task's prose and its code sample disagree, **stop and report** — that is a plan bug, not something to resolve by picking one.
- **A comment that promises behaviour the code does not implement is a bug.**

## Verified facts this plan depends on

Read from source before this plan was written. If one is false, stop and report.

- `contentTypeEnum` already exists (`product_update | blog_post | social_post`). `briefOriginEnum`, `briefStatusEnum`, `briefDismissReasonEnum` do not.
- `contentPieces` exists with `status` including `"brief"`, and has **no** `briefId` column yet. This plan does not add one — the accept flow lives in the second plan.
- `listSignals(tenantId, filters, database)` is in `src/lib/signals/query.ts`. Its `minScore` filter deliberately passes **null** scores through (`isNull OR gte`), because null means scoring *failed*, not "scored zero". Its 60-day window on `createdAt` is applied unconditionally and cannot be bypassed. `filters.from` narrows on `occurredAt`.
- `signalWindowCondition()` from `src/lib/signals/window.ts` is what any signal read must reuse rather than re-deriving. Its doc comment already records the obligation this plan makes real: signals cited by an **accepted** brief must be exempt from the eventual purge, because `brief_signals` cascades on signal delete.
- `scheduleConfigs` has `hour`, `lastRunAt`, `nextScheduledAt`, one row per tenant (`tenantId` is `.unique()`). Its comment records that `vercel.ts` pins a single daily fixed-time cron, so a per-tenant hour cannot be honoured today.
- `src/lib/ai/resolve-atomic-updates.ts` is the precedent for "hand the model open items plus new material, get back typed actions": `RESOLVER_BATCH_SIZE`, `ResolutionSchema`, `RESOLVER_SYSTEM`, `buildResolverPrompt(events, open)`. **Read it before Task 2.**
- The cron handler is `src/app/api/cron/scheduler/route.ts`; it checks `Bearer ${process.env.CRON_SECRET}` then awaits its steps sequentially with ordering comments.

## What the spikes settled — do not re-derive these

Two spikes are recorded in the design doc. Their findings are decisions, not suggestions:

- **No quota.** "Up to 6" produced exactly 6 every run, including on a hand-built quiet week where it invented a blog post *about there being nothing to write about*. The revised prompt returned **zero** briefs on two quiet weeks and 2–3 on rich ones. Expect a handful, never a full inbox.
- **The assessment comes first.** A required one-sentence judgement of the period, answered **before** the list, is what lets the model decline. Asked straight for items, it produces items.
- **Key points capped at 3–5, one sentence each**, and **no `outline` field**. The spike measured 6.5 points averaging 27 words plus a 41-word outline that only restated them. A brief is a commission, not a first draft.
- **`maxOutputTokens` must be set explicitly** — six uncapped briefs overflowed a 4096 default.
- **Four prompt rules carry over close to verbatim:** favour clusters, the swap test ("if it reads the same with a competitor's name swapped in, do not propose it"), ignore noise, and why-now must point at something dated.
- **Scores cluster narrowly (0.66–0.92)**, so absolute score ranks poorly once a backlog exists.

---

## File Structure

**Create:**
- `src/lib/briefs/ideate.ts` — the prompt, the schema, and the one model call. No database access.
- `src/lib/briefs/run.ts` — `runIdeation`: read → ideate → persist. One tenant in, briefs out.
- `src/lib/briefs/sweep.ts` — `sweepIdeation` (per-tenant fan-out) and `expireStaleBriefs`.
- `tests/lib/briefs/ideate.test.ts`, `tests/lib/briefs/run.test.ts`, `tests/lib/briefs/sweep.test.ts`

**Modify:**
- `src/db/schema.ts` — three enums, `briefs`, `brief_signals`, and the `window.ts`-related comment correction.
- `src/lib/ai/llm-usage.ts` — add `"ideation"` to the closed union.
- `src/lib/signals/window.ts` — the exemption note now has a real join to name.
- `src/app/api/cron/scheduler/route.ts` — one more step.
- `tests/app/api/cron/scheduler/route.test.ts` — its mock.

---

### Task 1: The `briefs` and `brief_signals` schema

**Files:**
- Modify: `src/db/schema.ts`, `src/lib/signals/window.ts`
- Create: a Drizzle migration via `npm run db:generate`
- Test: `tests/db/briefs-schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `briefs` and `briefSignals` Drizzle tables, `Brief` / `BriefSignal` inferred types, and the enums `briefOriginEnum`, `briefStatusEnum`, `briefDismissReasonEnum`.

**Column set** — from the design doc, with `outline` deliberately absent:

`id, tenantId, origin, createdBy?, contentType, title, angle, whyNow, suggestedChannel, audience?, keyPoints[], targetLength?, score, scoreRationale?, status, acceptedBy?, acceptedAt?, contentPieceId?, dismissReason?, dismissNote?, dismissedBy?, dismissedAt?, editedAt?, lastEvidenceAt, expiresAt, createdAt, updatedAt`

- [ ] **Step 1: Write the failing test**

Create `tests/db/briefs-schema.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, signals, briefs, briefSignals } from "../../src/db/schema";

const TENANT = "Briefs Schema Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seed() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

describe("briefs schema", () => {
  it("stores a brief with its key points and expiry", async () => {
    const tenant = await seed();

    const [brief] = await db
      .insert(briefs)
      .values({
        tenantId: tenant.id,
        origin: "agent",
        contentType: "blog_post",
        title: "Why localization belongs in the design tool",
        angle: "Argue the handoff is the bug, not the translation.",
        whyNow: "Ditto shipped a Figma plugin on 2026-08-04.",
        suggestedChannel: "blog",
        keyPoints: ["One.", "Two.", "Three."],
        score: 0.8,
        lastEvidenceAt: new Date(),
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      })
      .returning();

    expect(brief.status).toBe("new");
    expect(brief.origin).toBe("agent");
    expect(brief.keyPoints).toEqual(["One.", "Two.", "Three."]);
    expect(brief.contentPieceId).toBeNull();
  });

  it("cascades brief_signals when the signal is deleted", async () => {
    const tenant = await seed();
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        kind: "market_news",
        externalId: "https://news.example.com/a",
        title: "A story",
        occurredAt: new Date(),
      })
      .returning();
    const [brief] = await db
      .insert(briefs)
      .values({
        tenantId: tenant.id,
        origin: "agent",
        contentType: "blog_post",
        title: "T",
        angle: "A",
        whyNow: "W",
        suggestedChannel: "blog",
        keyPoints: ["One.", "Two.", "Three."],
        score: 0.5,
        lastEvidenceAt: new Date(),
        expiresAt: new Date(),
      })
      .returning();

    await db.insert(briefSignals).values({ briefId: brief.id, signalId: signal.id });
    await db.delete(signals).where(eq(signals.id, signal.id));

    const rows = await db.select().from(briefSignals).where(eq(briefSignals.briefId, brief.id));
    // This cascade is exactly why signals cited by an ACCEPTED brief must be
    // exempt from the eventual 60-day purge — see src/lib/signals/window.ts.
    expect(rows).toHaveLength(0);
  });

  it("refuses two briefs claiming the same content piece", async () => {
    const tenant = await seed();
    const base = {
      tenantId: tenant.id,
      origin: "agent" as const,
      contentType: "blog_post" as const,
      title: "T",
      angle: "A",
      whyNow: "W",
      suggestedChannel: "blog",
      keyPoints: ["One.", "Two.", "Three."],
      score: 0.5,
      lastEvidenceAt: new Date(),
      expiresAt: new Date(),
    };
    const pieceId = crypto.randomUUID();

    // A real content piece is not needed: the partial unique index is what is
    // under test, and contentPieceId has no FK in this plan (the accept flow
    // lands in the inbox plan).
    await db.insert(briefs).values({ ...base, contentPieceId: pieceId });

    await expect(db.insert(briefs).values({ ...base, contentPieceId: pieceId })).rejects.toThrow();
  });

  it("permits many briefs with no content piece", async () => {
    const tenant = await seed();
    const base = {
      tenantId: tenant.id,
      origin: "agent" as const,
      contentType: "blog_post" as const,
      title: "T",
      angle: "A",
      whyNow: "W",
      suggestedChannel: "blog",
      keyPoints: ["One.", "Two.", "Three."],
      score: 0.5,
      lastEvidenceAt: new Date(),
      expiresAt: new Date(),
    };

    await db.insert(briefs).values(base);
    // Postgres treats NULLs as distinct, so the partial index must not bite here.
    await expect(db.insert(briefs).values(base)).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/db/briefs-schema.test.ts`
Expected: FAIL — `briefs` is not exported from the schema.

- [ ] **Step 3: Add the enums and tables**

In `src/db/schema.ts`, beside the other enums:

```typescript
export const briefOriginEnum = pgEnum("brief_origin", ["agent", "manual"]);
export const briefStatusEnum = pgEnum("brief_status", ["new", "accepted", "dismissed", "expired"]);
export const briefDismissReasonEnum = pgEnum("brief_dismiss_reason", [
  "off_topic",
  "wrong_angle",
  "already_covered",
  "not_our_voice",
  "other",
]);
```

Then the tables. Place them after `signals` so the FK targets already exist:

```typescript
export const briefs = pgTable(
  "briefs",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    origin: briefOriginEnum("origin").notNull(),
    // Null for agent-proposed briefs. Set when a human creates one by hand
    // (the manual-creation spec).
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    contentType: contentTypeEnum("content_type").notNull(),
    title: text("title").notNull(),
    angle: text("angle").notNull(),
    whyNow: text("why_now").notNull(),
    // Text, not an enum: destinations will grow and Postgres has no DROP VALUE.
    suggestedChannel: text("suggested_channel").notNull(),
    audience: text("audience"),
    // 3-5 entries, one sentence each. The cap is enforced in the ideation
    // schema (zod) rather than here — a brief is a commission, not a first
    // draft, and the spike measured 6.5 points averaging 27 words when
    // uncapped. There is deliberately no `outline` column: ordered key points
    // ARE the outline, and keeping both guarantees they drift apart the first
    // time a human edits one.
    keyPoints: text("key_points").array().notNull().default([]),
    targetLength: integer("target_length"),
    // The model's own recommendation strength. The spike found these cluster
    // narrowly (0.66-0.92), so this ranks poorly on its own once a backlog
    // exists — the inbox orders by score AND recency, and see the accepted
    // gaps at the bottom of this plan.
    score: real("score").notNull(),
    scoreRationale: text("score_rationale"),
    status: briefStatusEnum("status").notNull().default("new"),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    // No FK: the accept flow lands in the inbox plan, and adding the reference
    // before anything writes it would be schema written ahead of its consumer.
    contentPieceId: uuid("content_piece_id"),
    dismissReason: briefDismissReasonEnum("dismiss_reason"),
    dismissNote: text("dismiss_note"),
    dismissedBy: uuid("dismissed_by").references(() => users.id, { onDelete: "set null" }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    // Follows the existing summaryEditedAt/bodyEditedAt convention: a human
    // edit freezes regeneration.
    editedAt: timestamp("edited_at", { withTimezone: true }),
    // Bumped whenever a later run attaches fresh evidence, so a brief that
    // keeps gathering support stays near the top instead of ageing out.
    lastEvidenceAt: timestamp("last_evidence_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("briefs_tenant_status_score_idx").on(table.tenantId, table.status, table.score),
    index("briefs_tenant_status_expires_idx").on(table.tenantId, table.status, table.expiresAt),
    // Two briefs must never claim the same piece. Partial because
    // contentPieceId is null for everything that has not been accepted, and
    // Postgres treats NULLs as distinct from one another.
    uniqueIndex("briefs_content_piece_unique")
      .on(table.contentPieceId)
      .where(sql`${table.contentPieceId} IS NOT NULL`),
  ]
);

export type Brief = typeof briefs.$inferSelect;

export const briefSignals = pgTable(
  "brief_signals",
  {
    briefId: uuid("brief_id")
      .notNull()
      .references(() => briefs.id, { onDelete: "cascade" }),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    // Null when the agent attached it; set when a human did.
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.briefId, table.signalId] })]
);

export type BriefSignal = typeof briefSignals.$inferSelect;
```

> `primaryKey` and `real` may not yet be imported in `schema.ts`. **`tsc` is what tells you** — add whatever the compiler asks for to the existing `drizzle-orm/pg-core` import rather than guessing which are already there.

- [ ] **Step 4: Make the retention note name the join that now exists**

`src/lib/signals/window.ts`'s comment currently ends *"Nothing enforces this yet because nothing deletes yet; this is the note for whoever adds the delete."* That is still true, but the join it warns about is no longer hypothetical. Append one sentence:

```
 * As of the brief agent, that join is `brief_signals`, which cascades on
 * signal delete — so a purge that ignores this exemption will not fail
 * loudly, it will quietly empty the evidence behind published content.
```

- [ ] **Step 5: Generate and inspect the migration**

Run: `npm run db:generate`

Open the generated SQL. It must contain: three `CREATE TYPE`, two `CREATE TABLE`, three `CREATE INDEX`/`CREATE UNIQUE INDEX`, and the foreign keys. **If it drops or alters anything that already exists, stop and report** — a generator rewriting unrelated schema is a disagreement to surface, not to accept.

- [ ] **Step 6: Apply and run the tests**

Run: `npm run db:migrate:test && npx vitest run tests/db/briefs-schema.test.ts`
Expected: PASS, 4 tests.

> **Also apply it to the dev database: `npm run db:migrate`.** A previous spec shipped a migration to the test database only; the feature then failed at runtime in local development with `42P10 no unique or exclusion constraint matching the ON CONFLICT specification`, and a green suite said nothing, because the suite runs against the migrated test database. Do both.

- [ ] **Step 7: Full suite, then commit**

Run: `npm run test && npm run typecheck && npm run lint`

```bash
git add src/db/schema.ts src/db/migrations src/lib/signals/window.ts tests/db/briefs-schema.test.ts
git commit -m "feat: add the briefs and brief_signals schema"
```

---

### Task 2: The ideation call

The one model call. Everything the spikes settled lives here.

**Files:**
- Create: `src/lib/briefs/ideate.ts`
- Modify: `src/lib/ai/llm-usage.ts`
- Test: `tests/lib/briefs/ideate.test.ts`

**Interfaces:**
- Consumes: `RelevanceProfile` from `@/lib/signals/relevance` (**import the existing type; do not define a second profile shape**), `resolveModel`/`modelId` from `@/lib/ai/model`, `recordLlmUsage` from `@/lib/ai/llm-usage`.
- Produces:
  - `type IdeationSignal = { id: string; kind: string; occurredAt: Date; title: string; excerpt: string | null }`
  - `type OpenBrief = { id: string; title: string; angle: string }`
  - `type IdeationContext = { covered: string[]; rejected: string[] }`
  - `type ProposedBrief = { contentType: "product_update" | "blog_post" | "social_post"; title: string; angle: string; whyNow: string; audience: string | null; keyPoints: string[]; targetLength: number | null; suggestedChannel: string; evidenceSignalIds: string[]; score: number; scoreRationale: string }`
  - `type IdeationAction = { type: "propose"; brief: ProposedBrief } | { type: "extend"; briefId: string; evidenceSignalIds: string[] }`
  - `type IdeationResult = { assessment: string; actions: IdeationAction[] } | { error: string }`
  - `async function ideate(args, deps?): Promise<IdeationResult>`
  - `const MAX_IDEATION_OUTPUT_TOKENS = 8_000`

**Design notes the implementer must not re-derive:**

- **Returns a result object; never throws.** The caller writes nothing on `{ error }`.
- **`assessment` is the first field in the zod object, before `actions`.** That ordering is the fix from the quiet-week spike: a model asked straight for items produces items, while one asked first whether the period merits anything will decline. Do not reorder it for tidiness.
- **`keyPoints` is `.min(3).max(5)` in the schema**, and each entry is one sentence.
- **There is no quota and no `outline`.**
- **Signal ids and brief ids are echoed back and validated against what was sent.** A model that invents an id must not cause a write. The spike measured zero hallucinated ids, which is a reason to check rather than a reason not to.

- [ ] **Step 1: Add the operation to the closed union**

In `src/lib/ai/llm-usage.ts`, add one member to `LlmOperation`, after `"news_selection"`:

```typescript
  | "ideation";
```

**Do this first** — the union is closed and the DB column is free text, so omitting it fails at `tsc` rather than at runtime.

- [ ] **Step 2: Write the failing tests**

Create `tests/lib/briefs/ideate.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { ideate, MAX_IDEATION_OUTPUT_TOKENS, type IdeationSignal, type OpenBrief } from "../../../src/lib/briefs/ideate";
import type { RelevanceProfile } from "../../../src/lib/signals/relevance";

vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn(async () => {}) }));

const PROFILE: RelevanceProfile = {
  name: "Acme",
  oneLiner: "Localization tooling for product teams.",
  positioning: "Fast where incumbents are configurable.",
  topics: ["localization"],
};

const signal = (id: string): IdeationSignal => ({
  id,
  kind: "market_news",
  occurredAt: new Date("2026-08-04T00:00:00Z"),
  title: `Story ${id}`,
  excerpt: `Body of ${id}.`,
});

function generateReturning(object: unknown) {
  return vi.fn().mockResolvedValue({ object, usage: { inputTokens: 10, outputTokens: 5 } });
}

const PROPOSAL = {
  contentType: "blog_post",
  title: "T",
  angle: "A",
  whyNow: "W",
  audience: null,
  keyPoints: ["One.", "Two.", "Three."],
  targetLength: 800,
  suggestedChannel: "blog",
  evidenceSignalIds: ["s1"],
  score: 0.8,
  scoreRationale: "R",
};

describe("ideate", () => {
  it("returns the assessment and a proposed brief", async () => {
    const generate = generateReturning({
      assessment: "A busy fortnight.",
      actions: [{ type: "propose", brief: PROPOSAL }],
    });

    const result = await ideate(
      { signals: [signal("s1")], openBriefs: [], context: { covered: [], rejected: [] }, profile: PROFILE, tenantId: "t1" },
      { generate }
    );

    expect("actions" in result).toBe(true);
    if (!("actions" in result)) return;
    expect(result.assessment).toBe("A busy fortnight.");
    expect(result.actions).toHaveLength(1);
  });

  it("accepts an empty action list — a quiet period is a correct outcome", async () => {
    const generate = generateReturning({ assessment: "Genuinely routine.", actions: [] });

    const result = await ideate(
      { signals: [signal("s1")], openBriefs: [], context: { covered: [], rejected: [] }, profile: PROFILE, tenantId: "t1" },
      { generate }
    );

    expect(result).toEqual({ assessment: "Genuinely routine.", actions: [] });
  });

  it("drops a proposal citing a signal id that was never sent", async () => {
    const generate = generateReturning({
      assessment: "x",
      actions: [
        { type: "propose", brief: { ...PROPOSAL, evidenceSignalIds: ["s1", "ghost"] } },
        { type: "propose", brief: { ...PROPOSAL, title: "All invented", evidenceSignalIds: ["ghost"] } },
      ],
    });

    const result = await ideate(
      { signals: [signal("s1")], openBriefs: [], context: { covered: [], rejected: [] }, profile: PROFILE, tenantId: "t1" },
      { generate }
    );

    expect("actions" in result).toBe(true);
    if (!("actions" in result)) return;
    // The phantom id is stripped from the surviving brief; a brief whose
    // evidence was ENTIRELY invented is dropped, because a brief with no real
    // evidence is not a brief.
    expect(result.actions).toHaveLength(1);
    const first = result.actions[0];
    expect(first.type === "propose" && first.brief.evidenceSignalIds).toEqual(["s1"]);
  });

  it("drops an extend action naming a brief that is not open", async () => {
    const open: OpenBrief[] = [{ id: "b1", title: "Existing", angle: "A" }];
    const generate = generateReturning({
      assessment: "x",
      actions: [
        { type: "extend", briefId: "b1", evidenceSignalIds: ["s1"] },
        { type: "extend", briefId: "nope", evidenceSignalIds: ["s1"] },
      ],
    });

    const result = await ideate(
      { signals: [signal("s1")], openBriefs: open, context: { covered: [], rejected: [] }, profile: PROFILE, tenantId: "t1" },
      { generate }
    );

    expect("actions" in result).toBe(true);
    if (!("actions" in result)) return;
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type === "extend" && result.actions[0].briefId).toBe("b1");
  });

  it("returns an error rather than throwing when the model call fails", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("overloaded"));

    const result = await ideate(
      { signals: [signal("s1")], openBriefs: [], context: { covered: [], rejected: [] }, profile: PROFILE, tenantId: "t1" },
      { generate }
    );

    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toContain("overloaded");
  });

  it("short-circuits an empty signal list without calling the model", async () => {
    const generate = vi.fn();

    const result = await ideate(
      { signals: [], openBriefs: [], context: { covered: [], rejected: [] }, profile: PROFILE, tenantId: "t1" },
      { generate }
    );

    expect(result).toEqual({ assessment: "No signals in the window.", actions: [] });
    expect(generate).not.toHaveBeenCalled();
  });

  it("carries the spike's four rules and the licence to return nothing", async () => {
    const generate = generateReturning({ assessment: "x", actions: [] });

    await ideate(
      { signals: [signal("s1")], openBriefs: [], context: { covered: [], rejected: [] }, profile: PROFILE, tenantId: "t1" },
      { generate }
    );

    const system = generate.mock.calls[0][0].system as string;
    expect(system).toMatch(/no target number/i);
    expect(system).toMatch(/empty list is a correct/i);
    expect(system).toMatch(/swapped in/i);          // the swap test
    expect(system).toMatch(/cluster/i);             // favour clusters
    expect(system).toMatch(/routine|maintenance|version bump/i); // ignore noise
    expect(system).toMatch(/dated|why-now/i);       // why-now points at something dated
    expect(generate.mock.calls[0][0].maxOutputTokens).toBe(MAX_IDEATION_OUTPUT_TOKENS);
  });

  it("puts covered and rejected context in the prompt", async () => {
    const generate = generateReturning({ assessment: "x", actions: [] });

    await ideate(
      {
        signals: [signal("s1")],
        openBriefs: [],
        context: { covered: ["We already shipped SSO"], rejected: ["Too promotional"] },
        profile: PROFILE,
        tenantId: "t1",
      },
      { generate }
    );

    const prompt = generate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("We already shipped SSO");
    expect(prompt).toContain("Too promotional");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/briefs/ideate.test.ts`
Expected: FAIL — `Cannot find module '../../../src/lib/briefs/ideate'`.

- [ ] **Step 4: Implement the ideation call**

Create `src/lib/briefs/ideate.ts`:

```typescript
import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "@/lib/ai/model";
import { recordLlmUsage } from "@/lib/ai/llm-usage";
import type { RelevanceProfile } from "@/lib/signals/relevance";

/**
 * The brief agent's one model call.
 *
 * Everything about its shape is a spike result, not a preference. Two spikes
 * are recorded in the design doc: the first established that an agent given a
 * company profile and real signals produces briefs a content lead would accept;
 * the second established that it will manufacture work on a quiet week unless
 * the prompt explicitly licenses silence. The second is the one that shaped
 * this file.
 *
 * Returns a result object and never throws. The caller writes nothing on an
 * error, because a run nobody judged has proposed nothing.
 */

/** Six uncapped briefs overflowed a 4096 default in the spike. */
export const MAX_IDEATION_OUTPUT_TOKENS = 8_000;

export type IdeationSignal = {
  id: string;
  kind: string;
  occurredAt: Date;
  title: string;
  excerpt: string | null;
};

export type OpenBrief = { id: string; title: string; angle: string };

export type IdeationContext = { covered: string[]; rejected: string[] };

export type ProposedBrief = {
  contentType: "product_update" | "blog_post" | "social_post";
  title: string;
  angle: string;
  whyNow: string;
  audience: string | null;
  keyPoints: string[];
  targetLength: number | null;
  suggestedChannel: string;
  evidenceSignalIds: string[];
  score: number;
  scoreRationale: string;
};

export type IdeationAction =
  | { type: "propose"; brief: ProposedBrief }
  | { type: "extend"; briefId: string; evidenceSignalIds: string[] };

export type IdeationResult = { assessment: string; actions: IdeationAction[] } | { error: string };

const ProposedBriefSchema = z.object({
  contentType: z.enum(["product_update", "blog_post", "social_post"]),
  title: z.string(),
  angle: z.string(),
  whyNow: z.string(),
  audience: z.string().nullish(),
  // 3-5, one sentence each. The spike measured 6.5 points averaging 27 words
  // when uncapped — something a writer skims rather than reads, and double the
  // output tokens of the highest-volume call in the system.
  keyPoints: z.array(z.string()).min(3).max(5),
  targetLength: z.number().int().nullish(),
  suggestedChannel: z.string(),
  evidenceSignalIds: z.array(z.string()),
  score: z.number(),
  scoreRationale: z.string(),
});

export const IdeationSchema = z.object({
  /**
   * Answered BEFORE the actions, deliberately. This ordering is the whole fix
   * from the quiet-week spike: asked straight for briefs the model returns
   * briefs, including on a week whose only material was a dependency bump and
   * a maintenance patch. Asked first whether the period merits anything, it
   * will say no. Do not move this below `actions`.
   */
  assessment: z.string(),
  actions: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("propose"), brief: ProposedBriefSchema }),
      z.object({
        type: z.literal("extend"),
        briefId: z.string(),
        evidenceSignalIds: z.array(z.string()),
      }),
    ])
  ),
});

export type IdeationGenerate = (args: {
  model: ReturnType<typeof resolveModel>;
  schema: typeof IdeationSchema;
  system: string;
  prompt: string;
  maxOutputTokens: number;
}) => Promise<{
  object: z.infer<typeof IdeationSchema>;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}>;

export type IdeateDeps = { generate?: IdeationGenerate };

function buildSystem(profile: RelevanceProfile): string {
  return [
    `You are the content strategist for ${profile.name}.`,
    profile.oneLiner ? `${profile.name} is: ${profile.oneLiner}` : null,
    profile.positioning ? `${profile.name}'s positioning: ${profile.positioning}` : null,
    profile.topics.length > 0 ? `Topics ${profile.name} cares about: ${profile.topics.join(", ")}.` : null,
    "",
    "Read everything that has happened recently and decide what — if anything —",
    "this company should publish.",
    "",
    "First, in one sentence, assess the period: is there anything here genuinely",
    "worth publishing about?",
    "",
    "Then propose whatever clears the bar. There is no target number.",
    "",
    "THE BAR. Propose a brief only if you would defend it in an editorial meeting",
    "to a skeptical head of marketing. If the honest answer to 'why are we",
    "publishing this?' is 'because it is Tuesday', it does not clear the bar.",
    "",
    "Most periods are quiet. Returning an empty list is a correct and common",
    "outcome, and it is the RIGHT answer when nothing of substance happened. A",
    "company that publishes nothing this week loses nothing. A company that",
    "publishes filler teaches its audience to ignore it, and that is not",
    "recoverable. Two strong briefs beat six padded ones; zero beats one padded.",
    "",
    "WHAT NEVER CLEARS THE BAR ALONE: routine version bumps, dependency updates,",
    "patch and maintenance releases, generic market-size statistics and analyst",
    "forecasts, a competitor's cosmetic or non-functional change, and anything",
    "whose why-now is 'this exists' rather than 'this happened'.",
    "",
    "FOR EACH BRIEF THAT DOES CLEAR IT:",
    "1. FAVOUR CLUSTERS. A brief joining two or more signals — especially across",
    "   different kinds, such as a competitor move beside something you shipped —",
    "   is almost always stronger than one restating a single changelog entry.",
    "2. THE SWAP TEST. If the brief would read exactly the same with a",
    "   competitor's name swapped in, it is worthless. Do not propose it.",
    "3. WHY-NOW MUST BE REAL. Point at something dated in the evidence. 'AI is a",
    "   big topic right now' is not a why-now.",
    "4. NO DUPLICATE ANGLES.",
    "5. MATCH TYPE TO SUBSTANCE. product_update for shipped work worth announcing,",
    "   blog_post for an argument needing room, social_post for one sharp point.",
    "6. KEY POINTS ARE A COMMISSION, NOT A DRAFT. Three to five, one sentence each.",
    "7. Only cite signal ids you were given.",
    "",
    "EXTENDING RATHER THAN REPEATING. You are shown the briefs already awaiting a",
    "decision. If new evidence supports one of those rather than justifying a",
    "separate piece, return an `extend` action naming its id instead of proposing",
    "a near-duplicate. An inbox that repeats itself within a week stops being read.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

function buildPrompt(
  signals: IdeationSignal[],
  openBriefs: OpenBrief[],
  context: IdeationContext,
): string {
  const sig = signals
    .map(
      (s) =>
        `[${s.id}] (${s.kind}, ${s.occurredAt.toISOString().slice(0, 10)})\n  ${s.title}\n  ${s.excerpt ?? "(no excerpt)"}`
    )
    .join("\n\n");

  const open =
    openBriefs.length > 0
      ? openBriefs.map((b) => `[${b.id}] ${b.title} — ${b.angle}`).join("\n")
      : "(none)";

  const covered = context.covered.length > 0 ? context.covered.map((c) => `- ${c}`).join("\n") : "(nothing yet)";
  const rejected =
    context.rejected.length > 0 ? context.rejected.map((r) => `- ${r}`).join("\n") : "(nothing yet)";

  return [
    "## Signals",
    "",
    sig,
    "",
    "## Briefs already awaiting a decision (extend these rather than repeating them)",
    "",
    open,
    "",
    "## Already covered — do not propose these again",
    "",
    covered,
    "",
    "## Previously rejected by this team, with their reasons — learn from these",
    "",
    rejected,
  ].join("\n");
}

export async function ideate(
  args: {
    signals: IdeationSignal[];
    openBriefs: OpenBrief[];
    context: IdeationContext;
    profile: RelevanceProfile;
    tenantId: string;
  },
  deps: IdeateDeps = {}
): Promise<IdeationResult> {
  if (args.signals.length === 0) return { assessment: "No signals in the window.", actions: [] };

  const generate = deps.generate ?? (generateObject as unknown as IdeationGenerate);

  try {
    const spec = process.env.IDEATION_MODEL ?? "anthropic/claude-sonnet-4-5";
    const { object, usage } = await generate({
      model: resolveModel(spec),
      schema: IdeationSchema,
      system: buildSystem(args.profile),
      prompt: buildPrompt(args.signals, args.openBriefs, args.context),
      maxOutputTokens: MAX_IDEATION_OUTPUT_TOKENS,
    });

    await recordLlmUsage({ tenantId: args.tenantId, operation: "ideation", model: modelId(spec), usage });

    const knownSignals = new Set(args.signals.map((s) => s.id));
    const knownBriefs = new Set(args.openBriefs.map((b) => b.id));
    const actions: IdeationAction[] = [];

    for (const action of object.actions) {
      if (action.type === "extend") {
        // An extend naming a brief we did not send has nothing to attach to.
        if (!knownBriefs.has(action.briefId)) continue;
        const ids = action.evidenceSignalIds.filter((id) => knownSignals.has(id));
        if (ids.length === 0) continue;
        actions.push({ type: "extend", briefId: action.briefId, evidenceSignalIds: ids });
        continue;
      }

      const ids = action.brief.evidenceSignalIds.filter((id) => knownSignals.has(id));
      // A brief whose evidence was entirely invented is not a brief. Stripping
      // phantom ids is enough when at least one real signal survives; when none
      // does, there is nothing for a human to check the claim against.
      if (ids.length === 0) continue;
      actions.push({
        type: "propose",
        brief: {
          ...action.brief,
          audience: action.brief.audience ?? null,
          targetLength: action.brief.targetLength ?? null,
          evidenceSignalIds: ids,
        },
      });
    }

    return { assessment: object.assessment, actions };
  } catch (error) {
    return { error: String(error) };
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/briefs/ideate.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Prove the id validation guards something**

Temporarily remove the `if (ids.length === 0) continue;` line in the `propose` branch and re-run. The "drops a proposal citing a signal id that was never sent" test must **fail** (2 actions instead of 1). Restore it. If it still passes, report rather than moving on — a test that cannot fail is worse than none, and this branch has shipped one before.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ai/llm-usage.ts src/lib/briefs/ideate.ts tests/lib/briefs/ideate.test.ts
git commit -m "feat: add the brief ideation call"
```

---

### Task 3: The per-tenant run

Read → ideate → persist. One tenant in, briefs out.

**Files:**
- Create: `src/lib/briefs/run.ts`
- Test: `tests/lib/briefs/run.test.ts`

**Interfaces:**
- Consumes: `ideate`, `IdeationSignal`, `OpenBrief`, `IdeationResult` (Task 2); `listSignals` from `@/lib/signals/query`; `briefs`, `briefSignals` (Task 1).
- Produces:
  - `type IdeationRunDeps = { ideateFn?: IdeateFn; database?: typeof defaultDb }`
  - `type IdeationRunResult = { proposed: number; extended: number; assessment: string | null }`
  - `async function runIdeation(tenantId: string, deps?: IdeationRunDeps): Promise<IdeationRunResult>`
  - `const IDEATION_WINDOW_DAYS = 30`, `const IDEATION_MIN_SCORE = 0.3`, `const BRIEF_TTL_DAYS = 14`, `const MAX_CONTEXT_ITEMS = 20`

**Design notes the implementer must not re-derive:**

- **Signals come from `listSignals`, not a hand-rolled query.** That function applies the 60-day retention window unconditionally and passes **null** relevance scores through its `minScore` filter, because null means scoring *failed*, not "scored zero". Re-deriving the query would lose both.
- **Ideation reads a 30-day window on `occurredAt`** (via `filters.from`), narrower than the 60-day retention window. Two different questions: what is recent enough to write about, versus how long a row is kept.
- **Only `new` briefs are offered for extension.** Accepted and dismissed ones go into the prompt as covered/rejected *context* instead. Offering them for extension would let a dismissed brief come back.
- **On `{ error }` the run writes nothing** and returns `assessment: null`.
- **Ranking is the model's `score`, stored as given.** The spike found scores cluster at 0.66–0.92, so this ranks poorly alone; the inbox will order by score *and* `lastEvidenceAt`. The design doc's fuller four-factor rank is an accepted gap, recorded at the bottom of this plan — do not invent one here.

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/briefs/run.test.ts`:

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, companyProfiles, signals, briefs, briefSignals } from "../../../src/db/schema";
import { runIdeation, BRIEF_TTL_DAYS } from "../../../src/lib/briefs/run";

const TENANT = "Ideation Run Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  vi.restoreAllMocks();
});

async function seedTenant(topics: string[] = ["localization"]) {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  await db.insert(companyProfiles).values({ tenantId: tenant.id, topics });
  return tenant;
}

async function seedSignal(tenantId: string, externalId: string, occurredAt = new Date()) {
  const [s] = await db
    .insert(signals)
    .values({
      tenantId,
      kind: "market_news",
      externalId,
      title: `Title ${externalId}`,
      excerpt: `Excerpt ${externalId}`,
      occurredAt,
      relevanceScore: 0.8,
    })
    .returning();
  return s;
}

const proposal = (evidence: string[]) => ({
  contentType: "blog_post" as const,
  title: "A brief",
  angle: "An angle",
  whyNow: "Because of something dated",
  audience: null,
  keyPoints: ["One.", "Two.", "Three."],
  targetLength: 800,
  suggestedChannel: "blog",
  evidenceSignalIds: evidence,
  score: 0.8,
  scoreRationale: "Strong",
});

describe("runIdeation", () => {
  it("writes a brief and its evidence join", async () => {
    const tenant = await seedTenant();
    const s = await seedSignal(tenant.id, "https://n.example.com/a");

    const result = await runIdeation(tenant.id, {
      database: db,
      ideateFn: vi.fn().mockResolvedValue({
        assessment: "Busy fortnight.",
        actions: [{ type: "propose", brief: proposal([s.id]) }],
      }),
    });

    expect(result).toMatchObject({ proposed: 1, extended: 0, assessment: "Busy fortnight." });

    const [brief] = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    expect(brief.origin).toBe("agent");
    expect(brief.status).toBe("new");
    expect(brief.title).toBe("A brief");
    expect(brief.keyPoints).toHaveLength(3);

    const joins = await db.select().from(briefSignals).where(eq(briefSignals.briefId, brief.id));
    expect(joins).toHaveLength(1);
    expect(joins[0].signalId).toBe(s.id);
    // Null addedBy is what marks agent-attached evidence.
    expect(joins[0].addedBy).toBeNull();
  });

  it("sets an expiry so the inbox cannot accumulate debt", async () => {
    const tenant = await seedTenant();
    const s = await seedSignal(tenant.id, "https://n.example.com/a");
    const before = Date.now();

    await runIdeation(tenant.id, {
      database: db,
      ideateFn: vi.fn().mockResolvedValue({ assessment: "x", actions: [{ type: "propose", brief: proposal([s.id]) }] }),
    });

    const [brief] = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    const expectedMin = before + (BRIEF_TTL_DAYS - 1) * 24 * 60 * 60 * 1000;
    expect(brief.expiresAt.getTime()).toBeGreaterThan(expectedMin);
  });

  it("extends an open brief instead of writing a duplicate", async () => {
    const tenant = await seedTenant();
    const s1 = await seedSignal(tenant.id, "https://n.example.com/a");
    const s2 = await seedSignal(tenant.id, "https://n.example.com/b");

    const [existing] = await db
      .insert(briefs)
      .values({
        tenantId: tenant.id,
        origin: "agent",
        contentType: "blog_post",
        title: "Existing",
        angle: "A",
        whyNow: "W",
        suggestedChannel: "blog",
        keyPoints: ["One.", "Two.", "Three."],
        score: 0.5,
        lastEvidenceAt: new Date("2026-01-01T00:00:00Z"),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    await db.insert(briefSignals).values({ briefId: existing.id, signalId: s1.id });

    const result = await runIdeation(tenant.id, {
      database: db,
      ideateFn: vi.fn().mockResolvedValue({
        assessment: "x",
        actions: [{ type: "extend", briefId: existing.id, evidenceSignalIds: [s2.id] }],
      }),
    });

    expect(result).toMatchObject({ proposed: 0, extended: 1 });

    const all = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    expect(all).toHaveLength(1);

    const joins = await db.select().from(briefSignals).where(eq(briefSignals.briefId, existing.id));
    expect(joins).toHaveLength(2);

    const [after] = all;
    // A brief that keeps gathering support must not age out.
    expect(after.lastEvidenceAt.getTime()).toBeGreaterThan(existing.lastEvidenceAt.getTime());
  });

  it("re-attaching the same signal to the same brief is idempotent", async () => {
    const tenant = await seedTenant();
    const s = await seedSignal(tenant.id, "https://n.example.com/a");
    const [existing] = await db
      .insert(briefs)
      .values({
        tenantId: tenant.id,
        origin: "agent",
        contentType: "blog_post",
        title: "Existing",
        angle: "A",
        whyNow: "W",
        suggestedChannel: "blog",
        keyPoints: ["One.", "Two.", "Three."],
        score: 0.5,
        lastEvidenceAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();
    await db.insert(briefSignals).values({ briefId: existing.id, signalId: s.id });

    await expect(
      runIdeation(tenant.id, {
        database: db,
        ideateFn: vi.fn().mockResolvedValue({
          assessment: "x",
          actions: [{ type: "extend", briefId: existing.id, evidenceSignalIds: [s.id] }],
        }),
      })
    ).resolves.toBeDefined();

    const joins = await db.select().from(briefSignals).where(eq(briefSignals.briefId, existing.id));
    expect(joins).toHaveLength(1);
  });

  it("offers only `new` briefs for extension, never accepted or dismissed ones", async () => {
    const tenant = await seedTenant();
    await seedSignal(tenant.id, "https://n.example.com/a");
    const base = {
      tenantId: tenant.id,
      origin: "agent" as const,
      contentType: "blog_post" as const,
      angle: "A",
      whyNow: "W",
      suggestedChannel: "blog",
      keyPoints: ["One.", "Two.", "Three."],
      score: 0.5,
      lastEvidenceAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    await db.insert(briefs).values({ ...base, title: "Still open", status: "new" });
    await db.insert(briefs).values({ ...base, title: "Already accepted", status: "accepted" });
    await db.insert(briefs).values({
      ...base,
      title: "Rejected once",
      status: "dismissed",
      dismissReason: "not_our_voice",
      dismissNote: "Too promotional",
    });

    const ideateFn = vi.fn().mockResolvedValue({ assessment: "x", actions: [] });
    await runIdeation(tenant.id, { database: db, ideateFn });

    const call = ideateFn.mock.calls[0][0];
    expect(call.openBriefs.map((b: { title: string }) => b.title)).toEqual(["Still open"]);
    // Accepted and dismissed briefs are context, not extension targets —
    // otherwise a dismissed brief comes straight back.
    expect(call.context.covered).toContain("Already accepted");
    expect(call.context.rejected.join(" ")).toContain("Too promotional");
  });

  it("writes nothing when ideation fails", async () => {
    const tenant = await seedTenant();
    await seedSignal(tenant.id, "https://n.example.com/a");

    const result = await runIdeation(tenant.id, {
      database: db,
      ideateFn: vi.fn().mockResolvedValue({ error: "Error: overloaded" }),
    });

    expect(result).toMatchObject({ proposed: 0, extended: 0, assessment: null });
    const all = await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id));
    expect(all).toHaveLength(0);
  });

  it("passes only signals inside the ideation window", async () => {
    const tenant = await seedTenant();
    const fresh = await seedSignal(tenant.id, "https://n.example.com/fresh", new Date());
    await seedSignal(tenant.id, "https://n.example.com/old", new Date(Date.now() - 45 * 24 * 60 * 60 * 1000));

    const ideateFn = vi.fn().mockResolvedValue({ assessment: "x", actions: [] });
    await runIdeation(tenant.id, { database: db, ideateFn });

    const passed = ideateFn.mock.calls[0][0].signals as { id: string }[];
    expect(passed.map((s) => s.id)).toEqual([fresh.id]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/briefs/run.test.ts`
Expected: FAIL — `Cannot find module '../../../src/lib/briefs/run'`.

- [ ] **Step 3: Implement the run**

Create `src/lib/briefs/run.ts`:

```typescript
import { and, desc, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { briefs, briefSignals, companyProfiles, tenants } from "@/db/schema";
import { listSignals } from "@/lib/signals/query";
import type { RelevanceProfile } from "@/lib/signals/relevance";
import {
  ideate,
  type IdeationContext,
  type IdeationResult,
  type IdeationSignal,
  type OpenBrief,
} from "./ideate";

/**
 * How far back ideation looks, on `occurredAt`. Narrower than the 60-day
 * retention window in `signals/window.ts` on purpose: "what is recent enough to
 * write about" is a different question from "how long do we keep the row".
 */
export const IDEATION_WINDOW_DAYS = 30;

/**
 * Signals below this relevance are not worth the strategist's attention.
 * `listSignals` deliberately lets NULL scores through this filter — null means
 * scoring FAILED, not "scored zero", and a silently dropped failure is exactly
 * what the signals browser exists to surface.
 */
export const IDEATION_MIN_SCORE = 0.3;

/** How long a brief waits for a decision before the sweep expires it. */
export const BRIEF_TTL_DAYS = 14;

/** Caps how much covered/rejected history reaches the prompt. */
export const MAX_CONTEXT_ITEMS = 20;

type IdeateFn = typeof ideate;

export type IdeationRunDeps = { ideateFn?: IdeateFn; database?: typeof defaultDb };

export type IdeationRunResult = {
  proposed: number;
  extended: number;
  /** The model's one-line judgement of the period. Null when the call failed. */
  assessment: string | null;
};

async function loadProfile(tenantId: string, database: typeof defaultDb): Promise<RelevanceProfile> {
  const [tenant] = await database.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  const [profile] = await database.select().from(companyProfiles).where(eq(companyProfiles.tenantId, tenantId));
  return {
    name: tenant?.name ?? "",
    oneLiner: profile?.oneLiner ?? null,
    positioning: profile?.positioning ?? null,
    topics: profile?.topics ?? [],
  };
}

/**
 * One tenant's ideation run.
 *
 * Writes nothing when the model call fails: a run nobody judged has proposed
 * nothing, and inventing briefs from a failure is the opposite of what the
 * human-gated model is for.
 */
export async function runIdeation(tenantId: string, deps: IdeationRunDeps = {}): Promise<IdeationRunResult> {
  const database = deps.database ?? defaultDb;
  const ideateFn = deps.ideateFn ?? ideate;

  const empty: IdeationRunResult = { proposed: 0, extended: 0, assessment: null };

  const profile = await loadProfile(tenantId, database);

  const from = new Date(Date.now() - IDEATION_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await listSignals(tenantId, { minScore: IDEATION_MIN_SCORE, from }, database);
  const ideationSignals: IdeationSignal[] = rows.map((s) => ({
    id: s.id,
    kind: s.kind,
    occurredAt: s.occurredAt,
    title: s.title,
    excerpt: s.excerpt,
  }));

  // Only `new` briefs can be extended. Accepted and dismissed ones become
  // context instead — offering a dismissed brief for extension would let the
  // team's own rejection come straight back next run.
  const openRows = await database
    .select({ id: briefs.id, title: briefs.title, angle: briefs.angle })
    .from(briefs)
    .where(and(eq(briefs.tenantId, tenantId), eq(briefs.status, "new")))
    .orderBy(desc(briefs.lastEvidenceAt));
  const openBriefs: OpenBrief[] = openRows;

  const acceptedRows = await database
    .select({ title: briefs.title })
    .from(briefs)
    .where(and(eq(briefs.tenantId, tenantId), eq(briefs.status, "accepted")))
    .orderBy(desc(briefs.acceptedAt))
    .limit(MAX_CONTEXT_ITEMS);

  const dismissedRows = await database
    .select({ title: briefs.title, reason: briefs.dismissReason, note: briefs.dismissNote })
    .from(briefs)
    .where(and(eq(briefs.tenantId, tenantId), eq(briefs.status, "dismissed")))
    .orderBy(desc(briefs.dismissedAt))
    .limit(MAX_CONTEXT_ITEMS);

  // Dismissal is training data: the reason and the note are what teach the next
  // run what this team does not want, which is what makes the tool feel like a
  // copilot rather than a generator.
  const context: IdeationContext = {
    covered: acceptedRows.map((r) => r.title),
    rejected: dismissedRows.map((r) =>
      [r.title, r.reason ? `(${r.reason})` : null, r.note].filter(Boolean).join(" ")
    ),
  };

  const outcome: IdeationResult = await ideateFn({
    signals: ideationSignals,
    openBriefs,
    context,
    profile,
    tenantId,
  });

  if ("error" in outcome) return empty;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + BRIEF_TTL_DAYS * 24 * 60 * 60 * 1000);
  let proposed = 0;
  let extended = 0;

  for (const action of outcome.actions) {
    if (action.type === "extend") {
      await database
        .update(briefs)
        .set({ lastEvidenceAt: now, updatedAt: now })
        .where(and(eq(briefs.id, action.briefId), eq(briefs.tenantId, tenantId)));
      await database
        .insert(briefSignals)
        .values(action.evidenceSignalIds.map((signalId) => ({ briefId: action.briefId, signalId })))
        // The PK on (briefId, signalId) makes re-attaching the same evidence a
        // no-op rather than an error — a later run legitimately sees the same
        // signal again.
        .onConflictDoNothing();
      extended++;
      continue;
    }

    const b = action.brief;
    const [inserted] = await database
      .insert(briefs)
      .values({
        tenantId,
        origin: "agent",
        contentType: b.contentType,
        title: b.title,
        angle: b.angle,
        whyNow: b.whyNow,
        suggestedChannel: b.suggestedChannel,
        audience: b.audience,
        keyPoints: b.keyPoints,
        targetLength: b.targetLength,
        score: b.score,
        scoreRationale: b.scoreRationale,
        lastEvidenceAt: now,
        expiresAt,
      })
      .returning({ id: briefs.id });

    await database
      .insert(briefSignals)
      // Null addedBy marks agent-attached evidence; a human attaching one sets it.
      .values(b.evidenceSignalIds.map((signalId) => ({ briefId: inserted.id, signalId })))
      .onConflictDoNothing();
    proposed++;
  }

  return { proposed, extended, assessment: outcome.assessment };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/briefs/run.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Prove the window filter guards something**

Temporarily drop `from` from the `listSignals` call and re-run. The "passes only signals inside the ideation window" test must **fail** (2 signals instead of 1). Restore it.

- [ ] **Step 6: Commit**

```bash
git add src/lib/briefs/run.ts tests/lib/briefs/run.test.ts
git commit -m "feat: add the per-tenant ideation run"
```

---

### Task 4: Expiry, the sweep, and cron wiring

**Files:**
- Create: `src/lib/briefs/sweep.ts`
- Modify: `src/app/api/cron/scheduler/route.ts`, `tests/app/api/cron/scheduler/route.test.ts`
- Test: `tests/lib/briefs/sweep.test.ts`

**Interfaces:**
- Consumes: `runIdeation` (Task 3), `briefs` (Task 1).
- Produces: `async function expireStaleBriefs(deps?): Promise<number>` and `async function sweepIdeation(deps?): Promise<void>`.

**This sweep must mirror `src/lib/signals/news-sweep.ts` in shape.** That shape is the product of a review that corrected two real defects: the candidate select gets its **own** try/catch that logs and returns (a throw would reject the whole cron handler and undo earlier steps), and the per-item try/catch is **per tenant, not one around the loop**, so one tenant's failure cannot stop the rest. **Read that file before writing this one.**

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/briefs/sweep.test.ts`:

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, companyProfiles, briefs } from "../../../src/db/schema";
import { expireStaleBriefs, sweepIdeation } from "../../../src/lib/briefs/sweep";

const TENANT = "Brief Sweep Test Tenant";
const OTHER = "Brief Sweep Other Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  await db.delete(tenants).where(eq(tenants.name, OTHER));
  vi.restoreAllMocks();
});

async function seedTenant(name: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  await db.insert(companyProfiles).values({ tenantId: tenant.id, topics: ["localization"] });
  return tenant;
}

async function seedBrief(tenantId: string, status: "new" | "accepted", expiresAt: Date) {
  const [b] = await db
    .insert(briefs)
    .values({
      tenantId,
      origin: "agent",
      contentType: "blog_post",
      title: "T",
      angle: "A",
      whyNow: "W",
      suggestedChannel: "blog",
      keyPoints: ["One.", "Two.", "Three."],
      score: 0.5,
      status,
      lastEvidenceAt: new Date(),
      expiresAt,
    })
    .returning();
  return b;
}

const past = new Date(Date.now() - 86_400_000);
const future = new Date(Date.now() + 86_400_000);

describe("expireStaleBriefs", () => {
  it("expires an undecided brief past its expiry", async () => {
    const tenant = await seedTenant(TENANT);
    const b = await seedBrief(tenant.id, "new", past);

    await expireStaleBriefs({ database: db });

    const [after] = await db.select().from(briefs).where(eq(briefs.id, b.id));
    expect(after.status).toBe("expired");
  });

  it("leaves an undecided brief that has not expired", async () => {
    const tenant = await seedTenant(TENANT);
    const b = await seedBrief(tenant.id, "new", future);

    await expireStaleBriefs({ database: db });

    const [after] = await db.select().from(briefs).where(eq(briefs.id, b.id));
    expect(after.status).toBe("new");
  });

  it("never touches a brief someone already acted on", async () => {
    const tenant = await seedTenant(TENANT);
    // Accepted long ago and long past its expiry: expiry is about undecided
    // work, and re-expiring a decision would rewrite history.
    const b = await seedBrief(tenant.id, "accepted", past);

    await expireStaleBriefs({ database: db });

    const [after] = await db.select().from(briefs).where(eq(briefs.id, b.id));
    expect(after.status).toBe("accepted");
  });
});

// NOTE: this sweep reads the whole shared test database, and other test files
// insert tenants concurrently. Every assertion below is scoped to ids this test
// created — never to a raw call count.
describe("sweepIdeation", () => {
  it("runs ideation for a tenant that has a company profile", async () => {
    const tenant = await seedTenant(TENANT);
    const seen: string[] = [];

    await sweepIdeation({
      database: db,
      runFn: async (tenantId) => {
        seen.push(tenantId);
        return { proposed: 0, extended: 0, assessment: null };
      },
    });

    expect(seen).toContain(tenant.id);
  });

  it("one tenant's failure does not stop another's", async () => {
    const angry = await seedTenant(TENANT);
    const calm = await seedTenant(OTHER);
    const seen: string[] = [];

    await expect(
      sweepIdeation({
        database: db,
        runFn: async (tenantId) => {
          if (tenantId === angry.id) throw new Error("boom");
          seen.push(tenantId);
          return { proposed: 0, extended: 0, assessment: null };
        },
      })
    ).resolves.toBeUndefined();

    expect(seen).toContain(calm.id);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/briefs/sweep.test.ts`
Expected: FAIL — `Cannot find module '../../../src/lib/briefs/sweep'`.

- [ ] **Step 3: Implement the sweep**

Create `src/lib/briefs/sweep.ts`:

```typescript
import { and, eq, lte } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { briefs, companyProfiles } from "@/db/schema";
import { runIdeation, type IdeationRunResult } from "./run";

export type ExpireDeps = { database?: typeof defaultDb };

/**
 * Expires briefs nobody decided on, so the inbox never accumulates debt.
 *
 * Only `new` briefs are touched. An accepted or dismissed brief is a decision
 * someone made; re-expiring it would rewrite history, and an already-expired
 * one has nothing to change.
 */
export async function expireStaleBriefs(deps: ExpireDeps = {}): Promise<number> {
  const database = deps.database ?? defaultDb;
  const rows = await database
    .update(briefs)
    .set({ status: "expired", updatedAt: new Date() })
    .where(and(eq(briefs.status, "new"), lte(briefs.expiresAt, new Date())))
    .returning({ id: briefs.id });
  return rows.length;
}

export type SweepIdeationDeps = {
  database?: typeof defaultDb;
  runFn?: (tenantId: string) => Promise<IdeationRunResult>;
};

/**
 * Cron fan-out for the ideation run, deliberately the same shape as
 * `src/lib/signals/news-sweep.ts`.
 *
 * The candidate select gets its own try/catch that logs and returns — a throw
 * here would reject the whole cron handler and undo the steps that ran before
 * it, and there is nothing to sweep if the select itself failed.
 *
 * Past that the try/catch is per *tenant*, so one tenant's failure cannot stop
 * the rest of the sweep.
 *
 * Candidates are tenants with a company profile: without one there is no
 * positioning and no topics, so ideation has nothing to reason from.
 */
export async function sweepIdeation(deps: SweepIdeationDeps = {}): Promise<void> {
  const database = deps.database ?? defaultDb;
  const runFn = deps.runFn ?? runIdeation;

  let candidates: { tenantId: string }[];
  try {
    candidates = await database
      .select({ tenantId: companyProfiles.tenantId })
      .from(companyProfiles)
      // Ordered only so the sweep is deterministic rather than dependent on
      // Postgres's plan. This is NOT fair rotation: `companyProfiles` carries
      // no last-run timestamp, so a sweep cut short would starve the same
      // tenants every time. `scheduleConfigs.lastRunAt` is the column that
      // would fix it, and nothing writes it yet — see the accepted gaps.
      .orderBy(companyProfiles.tenantId);
  } catch (error) {
    console.error("[ideation-sweep] failed to load candidate tenants:", error);
    return;
  }

  for (const { tenantId } of candidates) {
    try {
      await runFn(tenantId);
    } catch (error) {
      console.error(`[ideation-sweep] failed for tenant ${tenantId}:`, error);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/briefs/sweep.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire into the cron handler**

In `src/app/api/cron/scheduler/route.ts`, add the import beside the existing sweep imports and append after `sweepNewsSources()`:

```typescript
  // Runs last: ideation reads the signals every producer above it has just
  // finished writing, so a single cron run proposes briefs from that run's
  // material rather than yesterday's. Expiry runs first so a brief that aged
  // out this morning is not offered to the model as still-open.
  await expireStaleBriefs();
  await sweepIdeation();
```

Do not change the `CRON_SECRET` check, the existing calls, or their order.

- [ ] **Step 6: Mock the new steps in the cron route test — do not skip this**

`tests/app/api/cron/scheduler/route.test.ts` mocks every step because they are unscoped cross-tenant writes against the shared test database. Add a mock for the new module, following the exact pattern of the four already there:

```typescript
vi.mock("../../../../../src/lib/briefs/sweep", () => ({
  expireStaleBriefs: vi.fn(),
  sweepIdeation: vi.fn(),
}));
```

Add both to the reset block, assert both are not called in the 401 cases, and extend the ordering test's `expect(order).toEqual([...])` with `"expireStaleBriefs"` and `"sweepIdeation"` in their actual positions (last two).

**An unmocked `sweepIdeation` here would run real ideation — a paid model call per tenant — on every test run.** A previous spec shipped exactly this defect and it was caught only by the whole-plan review.

- [ ] **Step 7: Full verification**

Run: `npm run test && npm run typecheck && npm run lint`
Expected: all pass, lint 0 errors. Baseline before this plan: 151 files, 1108 tests, 9 lint warnings.

- [ ] **Step 8: Commit**

```bash
git add src/lib/briefs/sweep.ts tests/lib/briefs/sweep.test.ts src/app/api/cron/scheduler/route.ts tests/app/api/cron/scheduler/route.test.ts
git commit -m "feat: expire stale briefs and run ideation on the daily cron"
```

---

## After this plan: verify with a live run before building the inbox

The news agent's first live run found four defects no test could reach — a schema field that could be null, credit accounting that was always zero, a threshold off by an order of magnitude, and a query that returned press releases. **Do the same here before the inbox plan starts.** The dev database already has a tenant with a full profile and real `market_news` signals, so a run costs one model call.

What to look for: does the assessment read like judgement or like filler; do briefs cluster multiple signals or restate one each; is `score` spread wide enough to rank on; and does the swap test actually hold when you read the titles.

## Tunable knobs, deliberately

| Constant | Value | What it trades |
|---|---|---|
| `IDEATION_WINDOW_DAYS` | 30 | How far back a brief may reach for evidence |
| `IDEATION_MIN_SCORE` | 0.3 | How much signal noise reaches the strategist |
| `BRIEF_TTL_DAYS` | 14 | How long the inbox holds undecided work |
| `MAX_CONTEXT_ITEMS` | 20 | How much covered/rejected history the prompt carries |
| `MAX_IDEATION_OUTPUT_TOKENS` | 8,000 | Ceiling on one run's proposals |
| `IDEATION_MODEL` | `anthropic/claude-sonnet-4-5` | The spikes ran on Opus 5; Sonnet is the cost default and is worth A/B-ing on real signals |

## Known gaps, accepted

- **Ranking is the model's score alone.** The design doc names four factors — timeliness with decay, evidence strength, positioning fit, channel gap — and the spike warns that raw scores cluster at 0.66–0.92 and will rank poorly against a backlog. This plan stores the score and leaves ordering to the inbox (score, then `lastEvidenceAt`). Build the composite rank when there is a backlog to test it against, not before.
- **The ideation sweep does not rotate fairly.** It orders tenants by id for
  determinism only; `companyProfiles` has no last-run timestamp, so a sweep cut
  short would starve the same tenants every run. `scheduleConfigs.lastRunAt` is
  the column that would fix it and nothing writes it yet. Harmless at one or two
  tenants; fix it before that changes.
- **`scheduleConfigs.hour` is still not honoured.** `vercel.ts` pins one daily fixed-time cron on the Hobby plan, so every tenant ideates at the same hour. The column's own comment already records this; treat `hour` as a preferred window until the cron plan changes.
- **`assessment` is returned by `runIdeation` and then discarded by the sweep.** It is the right empty state for the inbox — "quiet week, here is why" beats a blank screen that reads as broken — and the design doc says so explicitly. The inbox plan should persist or surface it; nothing here does.
- **No per-tenant spend cap.** One ideation call per tenant per day, on top of the news selection call. Nothing bounds the total across tenants.
