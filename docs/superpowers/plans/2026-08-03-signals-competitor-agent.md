# Signals Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `signals` layer every later spec reads from, project existing shipped work into it, and make it visible behind a 60-day read window.

**Scope:** This is the first half of the design doc's spec 3. The competitor agent is the second half and needs its own plan — see "The competitor agent needs its own plan" below for why, and for the design decisions already settled for it.

**Architecture:** `signals` is one heterogeneous table written by several producers and read by one consumer (spec 5's brief agent). Producers follow the shape `resolve-sweep.ts` already establishes: a cron sweep grouped per tenant, each tenant wrapped in its own try/catch so one failure cannot undo the rest of the cron's work. Shipped work is *reconciled* into signals rather than hooked at creation, because there are three `insert(atomicUpdates)` sites and no shared helper.

**Tech Stack:** Next.js 16 (App Router), Drizzle ORM + drizzle-kit, Postgres (Supabase), AI SDK v7 + `@ai-sdk/anthropic`, Vitest against a real `_test` database, TypeScript strict.

## Global Constraints

- **This is not the Next.js you know.** Read the relevant guide in `node_modules/next/dist/docs/` before writing any App Router code. Heed deprecation notices. (`AGENTS.md`)
- Tests run against a **real Postgres database whose name must end in `_test`** (`vitest.setup.ts` hard-fails otherwise). After every schema change run `npm run db:migrate:test` before `npm run test`.
- The LLM provider is **Anthropic directly** via `@ai-sdk/anthropic`, not the Vercel AI Gateway. Do not "fix" this.
- Every LLM call records usage via `recordLlmUsage`. **`operation` is typed as `LlmOperation`, a closed string-literal union in `src/lib/ai/llm-usage.ts`** — a new operation must be added there or the call will not type-check. The database column is free text, so this is invisible until `tsc` runs.
- **Every external page fetch goes through `fetchPageText`** (`src/lib/workspace/fetch-page.ts`). Nothing in this plan fetches, but this binds the competitor-agent plan absolutely: that function carries redirect re-validation, private-IP rejection, a hard byte cap, a timeout, and a scan clamp against quadratic regex backtracking. A bare `fetch` to a competitor URL bypasses all of it.
- Follow the existing schema conventions in `src/db/schema.ts`: comments explain *why* a column exists, not what it is.
- Never edit the Vercel `DATABASE_URL` env var.
- **Deletion lists come from exports and importers, never from a module's name.** Spec 1 lost coverage five times by trusting that a directory or file name described its contents. Before deleting or wholesale-replacing any file, `grep -n "^export"` it and grep its importers.

## Decisions this plan locks in

**Shipped work is reconciled, not hooked.** Atomic updates are created in three places (`create-from-events.ts:168`, `reassign.ts:241`, `apply-resolution.ts:84`) with no shared helper. Hooking all three means a fourth site added later silently stops producing signals. Instead `syncShippedWorkSignals` reconciles: it upserts a signal for every non-hidden atomic update and deletes signals whose atomic update is gone or hidden. Idempotent, self-healing, and it makes hide/unhide work for free.

**There is no deletion yet — the 60-day window is enforced on read.** Nothing prunes the table in this plan. Every reader filters to the last 60 days instead, which defers the irreversible half of retention until the shape of the data is known. Deletion lands later.

**The window keys off `createdAt`, not `occurredAt`, and it is defined once.** Two reasons. First, the window answers "how long do we consider this", not "how old is the news" — a backfilled competitor post from last year would be invisible on arrival under an `occurredAt` rule. Second and more important: **when real deletion is built it must use the same column and the same number as this read window.** If they diverge, you get either signals that are visible but already scheduled for deletion, or signals retained forever that nobody can see. `SIGNAL_WINDOW_DAYS` lives in one module so the browser, spec 5's ideation read, and the eventual deleter cannot drift apart.

**`sources` lands in Task 1 alongside `signals`.** It has no consumer until the agent plan, but its foreign key is what `signals.sourceId` points at — declaring both together means one migration and a well-formed key from the start, rather than a second migration to add the reference later.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/db/schema.ts` | `signals` and `sources` tables and their enums | 1 |
| `src/lib/signals/shipped-work.ts` | Reconcile atomic updates → signals | 1 |
| `src/lib/signals/window.ts` | The single definition of the 60-day signal window | 2 |
| `src/app/(dashboard)/signals/*` | The signals browser | 2 |
| `src/lib/signals/query.ts` | Filtered signal reads, windowed | 2 |
| `src/app/api/cron/scheduler/route.ts` | Runs the shipped-work sync | 1 |

---

### Task 1: `signals` and `sources` schema, and the shipped-work reconciler

**Files:**
- Modify: `src/db/schema.ts`, `src/app/api/cron/scheduler/route.ts`
- Create: `src/lib/signals/shipped-work.ts`
- Test: `tests/db/signals-schema.test.ts`, `tests/lib/signals/shipped-work.test.ts`

**Interfaces:**
- Consumes: `atomicUpdates`, `competitors` (spec 2), `tenants`
- Produces: `signals` and `sources` table exports; `Signal` and `Source` types; `syncShippedWorkSignals(deps?): Promise<void>`

- [ ] **Step 1: Write the failing schema test**

Create `tests/db/signals-schema.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, signals, atomicUpdates } from "../../src/db/schema";

const TENANT = "Signals Schema Test Tenant";

describe("signals schema", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("defaults status to new and topics to an empty array", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        kind: "competitor_move",
        externalId: "e1",
        title: "They shipped SSO",
        occurredAt: new Date("2026-07-01"),
      })
      .returning();
    expect(signal.status).toBe("new");
    expect(signal.topics).toEqual([]);
    expect(signal.relevanceScore).toBeNull();
  });

  it("rejects a duplicate externalId within the same tenant and kind", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const base = { tenantId: tenant.id, kind: "competitor_move" as const, externalId: "dup", title: "T", occurredAt: new Date() };
    await db.insert(signals).values(base);
    await expect(db.insert(signals).values(base)).rejects.toThrow();
  });

  it("allows the same externalId under a different kind", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    await db.insert(signals).values({ tenantId: tenant.id, kind: "competitor_move", externalId: "x", title: "T", occurredAt: new Date() });
    await expect(
      db.insert(signals).values({ tenantId: tenant.id, kind: "market_news", externalId: "x", title: "T", occurredAt: new Date() })
    ).resolves.toBeDefined();
  });

  it("nulls atomicUpdateId when the atomic update is deleted, keeping the signal", async () => {
    const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
    const [atomic] = await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "A", summary: "S" }).returning();
    const [signal] = await db
      .insert(signals)
      .values({ tenantId: tenant.id, kind: "shipped_work", externalId: atomic.id, title: "A", occurredAt: new Date(), atomicUpdateId: atomic.id })
      .returning();

    await db.delete(atomicUpdates).where(eq(atomicUpdates.id, atomic.id));
    const [after] = await db.select().from(signals).where(eq(signals.id, signal.id));
    expect(after).toBeDefined();
    expect(after.atomicUpdateId).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/db/signals-schema.test.ts`
Expected: FAIL — `signals` is not exported from `src/db/schema`.

- [ ] **Step 3: Add the enums and both tables**

In `src/db/schema.ts`, with the other enums at the top of the file:

```ts
export const signalKindEnum = pgEnum("signal_kind", ["shipped_work", "competitor_move", "market_news", "manual"]);
export const signalStatusEnum = pgEnum("signal_status", ["new", "used", "stale"]);
export const sourceTypeEnum = pgEnum("source_type", ["competitor_web", "news"]);
export const sourceStatusEnum = pgEnum("source_status", ["active", "failing", "disabled"]);
```

Then, after `competitors`:

```ts
export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    type: sourceTypeEnum("type").notNull(),
    // Set for competitor_web sources. One competitor can have several sources —
    // a changelog and a blog are watched separately because they publish at
    // different rhythms and carry different signal.
    competitorId: uuid("competitor_id").references(() => competitors.id, { onDelete: "cascade" }),
    // The page we poll. Null for topic-driven news sources (spec 4), which
    // search rather than fetch a fixed URL.
    url: text("url"),
    // The feed discovered behind `url`, when the page advertises one. Preferred
    // over scraping because feed entries carry real titles and dates.
    feedUrl: text("feed_url"),
    label: text("label").notNull(),
    // Per-source cursor: last seen entry id and the content hash of the last
    // fetched page. Shape varies by source type, which is why it is jsonb and
    // not columns — a news source's cursor looks nothing like a feed's.
    watermark: jsonb("watermark").$type<Record<string, unknown>>().notNull().default({}),
    // Sources rot: sites redesign, feeds move. Surfaced in settings the way the
    // Notion and Webflow connection statuses already are, rather than failing
    // silently for weeks.
    status: sourceStatusEnum("status").notNull().default("active"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per watched URL per tenant, so re-running discovery tops up
    // instead of duplicating.
    uniqueIndex("sources_tenant_url_unique").on(table.tenantId, table.url),
  ]
);

export type Source = typeof sources.$inferSelect;

export const signals = pgTable(
  "signals",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
    kind: signalKindEnum("kind").notNull(),
    // Idempotency key, namespaced per kind. Shipped work uses the atomic
    // update's id; feed entries use their guid; news uses the article URL.
    externalId: text("external_id").notNull(),
    url: text("url"),
    title: text("title").notNull(),
    excerpt: text("excerpt"),
    // When the thing happened, as distinct from when we noticed it. Ranking in
    // spec 5 decays on this, so a backfilled old post must not read as fresh.
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    // Set on shipped_work signals. ON DELETE SET NULL rather than cascade: the
    // signal is the durable record of what happened, and losing the atomic
    // update should not erase the evidence a published piece was built from.
    atomicUpdateId: uuid("atomic_update_id").references(() => atomicUpdates.id, { onDelete: "set null" }),
    competitorId: uuid("competitor_id").references(() => competitors.id, { onDelete: "set null" }),
    // Null means scoring failed, not "scored zero" — the rationale says which.
    // A failed classifier writes the signal anyway: a missed competitor move is
    // invisible, an unscored row in the browser announces itself.
    relevanceScore: real("relevance_score"),
    relevanceRationale: text("relevance_rationale"),
    topics: text("topics").array().notNull().default([]),
    // `used` is a reporting and pruning flag, NOT a consumption gate. Spec 5's
    // ideation reads every signal in its window regardless of status, because a
    // signal cited last week can join a new cluster this week.
    status: signalStatusEnum("status").notNull().default("new"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("signals_tenant_kind_external_unique").on(table.tenantId, table.kind, table.externalId),
    index("signals_tenant_occurred_idx").on(table.tenantId, table.occurredAt),
    index("signals_tenant_kind_occurred_idx").on(table.tenantId, table.kind, table.occurredAt),
  ]
);

export type Signal = typeof signals.$inferSelect;
```

Generate and apply — this is a pure addition and should not prompt:

```bash
npm run db:generate && npm run db:migrate && npm run db:migrate:test
npx vitest run tests/db/signals-schema.test.ts
```

- [ ] **Step 4: Write the failing reconciler test**

Create `tests/lib/signals/shipped-work.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, atomicUpdates, signals } from "../../../src/db/schema";
import { syncShippedWorkSignals } from "../../../src/lib/signals/shipped-work";

const TENANT = "Shipped Work Signals Test Tenant";

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

async function shippedSignals(tenantId: string) {
  return db.select().from(signals).where(and(eq(signals.tenantId, tenantId), eq(signals.kind, "shipped_work")));
}

describe("syncShippedWorkSignals", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("projects an open atomic update into a signal", async () => {
    const tenant = await seedTenant();
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "SAML SSO", summary: "Teams can log in with SAML." })
      .returning();

    await syncShippedWorkSignals();

    const rows = await shippedSignals(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe(atomic.id);
    expect(rows[0].atomicUpdateId).toBe(atomic.id);
    expect(rows[0].title).toBe("SAML SSO");
    expect(rows[0].excerpt).toBe("Teams can log in with SAML.");
  });

  it("is idempotent across runs", async () => {
    const tenant = await seedTenant();
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "A", summary: "S" });
    await syncShippedWorkSignals();
    await syncShippedWorkSignals();
    expect(await shippedSignals(tenant.id)).toHaveLength(1);
  });

  it("refreshes title and excerpt when the atomic update changes", async () => {
    const tenant = await seedTenant();
    const [atomic] = await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "Old", summary: "Old summary" }).returning();
    await syncShippedWorkSignals();

    await db.update(atomicUpdates).set({ title: "New", summary: "New summary" }).where(eq(atomicUpdates.id, atomic.id));
    await syncShippedWorkSignals();

    const rows = await shippedSignals(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("New");
    expect(rows[0].excerpt).toBe("New summary");
  });

  it("removes the signal when the atomic update is hidden, and restores it when unhidden", async () => {
    const tenant = await seedTenant();
    const [atomic] = await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "A", summary: "S" }).returning();
    await syncShippedWorkSignals();
    expect(await shippedSignals(tenant.id)).toHaveLength(1);

    await db.update(atomicUpdates).set({ status: "hidden" }).where(eq(atomicUpdates.id, atomic.id));
    await syncShippedWorkSignals();
    expect(await shippedSignals(tenant.id)).toHaveLength(0);

    await db.update(atomicUpdates).set({ status: "open" }).where(eq(atomicUpdates.id, atomic.id));
    await syncShippedWorkSignals();
    expect(await shippedSignals(tenant.id)).toHaveLength(1);
  });

  it("projects released atomic updates too — shipping is exactly what makes them signal", async () => {
    const tenant = await seedTenant();
    await db.insert(atomicUpdates).values({ tenantId: tenant.id, title: "A", summary: "S", status: "released" });
    await syncShippedWorkSignals();
    expect(await shippedSignals(tenant.id)).toHaveLength(1);
  });
});
```

- [ ] **Step 5: Run it to confirm it fails**

Run: `npx vitest run tests/lib/signals/shipped-work.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Implement the reconciler**

Create `src/lib/signals/shipped-work.ts`. Read `src/lib/change-events/resolve-sweep.ts` first and match its error-handling posture — log and return, never throw, because this runs alongside other cron steps whose completed work must not be undone.

```ts
import { and, eq, ne, notInArray } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, signals } from "@/db/schema";

export type ShippedWorkDeps = { database?: typeof defaultDb };

/**
 * Reconciles atomic updates into `shipped_work` signals.
 *
 * A reconciler rather than a hook at creation: atomic updates are inserted in
 * three places with no shared helper, so a fourth site added later would
 * silently stop producing signals. Reconciling is idempotent, self-healing, and
 * gets hide/unhide for free — a hidden update's signal disappears and comes back
 * when it is unhidden.
 *
 * `externalId` is the atomic update's id, so the unique index on
 * (tenantId, kind, externalId) is what makes the upsert safe.
 */
export async function syncShippedWorkSignals(deps: ShippedWorkDeps = {}): Promise<void> {
  const database = deps.database ?? defaultDb;

  try {
    const visible = await database
      .select({
        id: atomicUpdates.id,
        tenantId: atomicUpdates.tenantId,
        title: atomicUpdates.title,
        summary: atomicUpdates.summary,
        createdAt: atomicUpdates.createdAt,
      })
      .from(atomicUpdates)
      .where(ne(atomicUpdates.status, "hidden"));

    for (const update of visible) {
      await database
        .insert(signals)
        .values({
          tenantId: update.tenantId,
          kind: "shipped_work",
          externalId: update.id,
          title: update.title,
          excerpt: update.summary,
          occurredAt: update.createdAt,
          atomicUpdateId: update.id,
        })
        .onConflictDoUpdate({
          target: [signals.tenantId, signals.kind, signals.externalId],
          // Refresh only what can change upstream. Never touch relevanceScore,
          // topics or status — those belong to whatever scored or cited this
          // signal, and a re-sync must not undo them.
          set: { title: update.title, excerpt: update.summary, atomicUpdateId: update.id },
        });
    }

    // Withdraw signals whose atomic update went away or was hidden. Scoped to
    // this kind so no other producer's rows are ever touched.
    const visibleIds = visible.map((update) => update.id);
    await database.delete(signals).where(
      visibleIds.length > 0
        ? and(eq(signals.kind, "shipped_work"), notInArray(signals.externalId, visibleIds))
        : eq(signals.kind, "shipped_work")
    );
  } catch (error) {
    // Runs alongside other cron steps; a failure here must not reject the whole
    // handler and undo their completed work. Next run reconciles.
    console.error("[shipped-work-signals] sync failed:", error);
  }
}
```

- [ ] **Step 7: Wire it into the cron**

In `src/app/api/cron/scheduler/route.ts`, add `await syncShippedWorkSignals();` after `sweepUnresolvedEvents()` — signals must be projected from atomic updates that this same run may have just created. Keep the `CRON_SECRET` check and the existing calls exactly as they are.

- [ ] **Step 8: Verify and commit**

```bash
npm run typecheck && npm run test && npm run lint
git add -A
git commit -m "feat: signals and sources schema, shipped-work reconciler

Projects atomic updates into signals by reconciliation rather than a
creation hook: three insert sites and no shared helper means a fourth
would silently stop producing. Hide/unhide works for free."
```

---

### Task 2: The signals browser

An ingestion pipeline you cannot see is undebuggable. This ships **before** the competitor agent deliberately, so the first external run lands on a working surface.

**Files:**
- Create: `src/lib/signals/window.ts`, `src/lib/signals/query.ts`
- Create: `src/app/(dashboard)/signals/page.tsx`, `signals-list.tsx`, `signals-filters.tsx`, `signal-row.tsx`
- Modify: `src/app/(dashboard)/nav-links.tsx`
- Test: `tests/lib/signals/query.test.ts` (query-level, not render-level)

**Interfaces:**
- Consumes: `signals`, `sources`, `competitors`
- Produces: `SIGNAL_WINDOW_DAYS` and `signalWindowStart(now: Date): Date` in `src/lib/signals/window.ts`; `listSignals(tenantId, filters, database?): Promise<Signal[]>` in `src/lib/signals/query.ts`

- [ ] **Step 0: Define the window in one place**

Create `src/lib/signals/window.ts`:

```ts
/**
 * How far back signals are considered. Enforced on READ — nothing deletes from
 * the table yet, deliberately: the irreversible half of retention waits until
 * the shape of the data is known.
 *
 * When deletion is built it MUST use this same constant and the same column
 * (`createdAt`). If the delete rule and this read window ever diverge you get
 * signals that are visible but already scheduled for deletion, or signals
 * retained forever that nobody can see. That is why this lives in its own
 * module rather than as a literal in the query.
 */
export const SIGNAL_WINDOW_DAYS = 60;

/** The oldest `createdAt` still inside the window. */
export function signalWindowStart(now: Date): Date {
  return new Date(now.getTime() - SIGNAL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}
```

- [ ] **Step 1: Write the failing query test**

The filtering logic is what matters and what can regress; rendering is not worth a render test behind an OAuth wall. Put the query in `src/lib/signals/query.ts` and test it directly.

Create `tests/lib/signals/query.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, competitors, signals } from "../../../src/db/schema";
import { listSignals } from "../../../src/lib/signals/query";

const TENANT = "Signals Query Test Tenant";
const OTHER = "Signals Query Other Tenant";

async function seedTenant(name: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  return tenant;
}

let counter = 0;
async function seedSignal(tenantId: string, overrides: Partial<typeof signals.$inferInsert> = {}) {
  const [signal] = await db
    .insert(signals)
    .values({
      tenantId,
      kind: "competitor_move",
      externalId: `e${counter++}`,
      title: "T",
      occurredAt: new Date("2026-07-15"),
      ...overrides,
    })
    .returning();
  return signal;
}

describe("listSignals", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
    await db.delete(tenants).where(eq(tenants.name, OTHER));
  });

  it("returns only the caller's tenant's signals", async () => {
    const mine = await seedTenant(TENANT);
    const theirs = await seedTenant(OTHER);
    const ours = await seedSignal(mine.id);
    await seedSignal(theirs.id);

    const rows = await listSignals(mine.id, {});
    expect(rows.map((r) => r.id)).toEqual([ours.id]);
  });

  it("filters by kind", async () => {
    const tenant = await seedTenant(TENANT);
    const shipped = await seedSignal(tenant.id, { kind: "shipped_work" });
    await seedSignal(tenant.id, { kind: "competitor_move" });

    const rows = await listSignals(tenant.id, { kind: "shipped_work" });
    expect(rows.map((r) => r.id)).toEqual([shipped.id]);
  });

  it("filters by competitor", async () => {
    const tenant = await seedTenant(TENANT);
    const [rival] = await db.insert(competitors).values({ tenantId: tenant.id, name: "Jira" }).returning();
    const theirs = await seedSignal(tenant.id, { competitorId: rival.id });
    await seedSignal(tenant.id);

    const rows = await listSignals(tenant.id, { competitorId: rival.id });
    expect(rows.map((r) => r.id)).toEqual([theirs.id]);
  });

  it("keeps unscored signals when a minimum score is set", async () => {
    const tenant = await seedTenant(TENANT);
    const unscored = await seedSignal(tenant.id, { relevanceScore: null });
    const high = await seedSignal(tenant.id, { relevanceScore: 0.9 });
    await seedSignal(tenant.id, { relevanceScore: 0.1 });

    const rows = await listSignals(tenant.id, { minScore: 0.5 });
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set([unscored.id, high.id]));
  });

  it("filters by occurredAt range", async () => {
    const tenant = await seedTenant(TENANT);
    const inRange = await seedSignal(tenant.id, { occurredAt: new Date("2026-07-15") });
    await seedSignal(tenant.id, { occurredAt: new Date("2026-05-01") });

    const rows = await listSignals(tenant.id, { from: new Date("2026-07-01"), to: new Date("2026-08-01") });
    expect(rows.map((r) => r.id)).toEqual([inRange.id]);
  });

  it("orders newest first by occurredAt", async () => {
    const tenant = await seedTenant(TENANT);
    const older = await seedSignal(tenant.id, { occurredAt: new Date("2026-07-01") });
    const newer = await seedSignal(tenant.id, { occurredAt: new Date("2026-07-20") });

    const rows = await listSignals(tenant.id, {});
    expect(rows.map((r) => r.id)).toEqual([newer.id, older.id]);
  });

  it("excludes stale signals unless asked for them", async () => {
    const tenant = await seedTenant(TENANT);
    const fresh = await seedSignal(tenant.id);
    const stale = await seedSignal(tenant.id, { status: "stale" });

    expect((await listSignals(tenant.id, {})).map((r) => r.id)).toEqual([fresh.id]);
    expect(new Set((await listSignals(tenant.id, { includeStale: true })).map((r) => r.id))).toEqual(
      new Set([fresh.id, stale.id])
    );
  });

  it("excludes signals created outside the 60-day window", async () => {
    const tenant = await seedTenant(TENANT);
    const inside = await seedSignal(tenant.id, { createdAt: daysAgo(59) });
    await seedSignal(tenant.id, { createdAt: daysAgo(70) });

    const rows = await listSignals(tenant.id, {});
    expect(rows.map((r) => r.id)).toEqual([inside.id]);
  });

  it("windows on createdAt, so a freshly-ingested old post is still visible", async () => {
    const tenant = await seedTenant(TENANT);
    const backfilled = await seedSignal(tenant.id, {
      createdAt: daysAgo(1),
      occurredAt: daysAgo(400),
    });

    const rows = await listSignals(tenant.id, {});
    expect(rows.map((r) => r.id)).toEqual([backfilled.id]);
  });
});
```

Add the helper the last two cases use, alongside `seedSignal`:

```ts
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}
```

Two cases carry most of the value here. **The unscored-signal case:** a `>= minScore` comparison drops NULLs silently in SQL, which would hide exactly the rows a debugging surface exists to show. **The `createdAt` window case:** it pins the column the window uses, which is what stops a future deletion job from being written against `occurredAt` and silently disagreeing with what the browser shows.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/app/signals-page.test.ts`
Expected: FAIL — `listSignals` not exported.

- [ ] **Step 3: Implement the query and the page**

`listSignals` takes `{ kind?, competitorId?, minScore?, from?, to?, includeStale? }` and composes `and(...)` conditions, omitting any filter that is undefined.

**The 60-day window is not one of those optional filters — it is always applied.** Start the condition list with `gte(signals.createdAt, signalWindowStart(new Date()))` from `src/lib/signals/window.ts`, before any caller-supplied filter. It is not a parameter and callers cannot opt out: it is the stand-in for deletion, and a read path that can bypass it would show data the eventual delete job has already discarded.

**The unscored case is the one to get right.** A signal whose `relevanceScore` is null failed scoring — it is not low-relevance. A `>= minScore` comparison silently drops NULLs in SQL, which would hide exactly the rows a debugging surface exists to show. Treat null as always-included when a minimum is set, and label it in the UI as "not scored" rather than showing a blank.

The `from`/`to` filters narrow *within* the window on `occurredAt` — they are a user-facing date filter over when things happened, which is a different question from how long we keep them. Do not collapse the two.

For the page, follow `src/app/(dashboard)/change-events/` — it already has the page / list / filters / row split and a filter component driven by search params. Match that structure rather than inventing one.

Add a nav entry. The browser is read-only in this task; selection and manual signal creation are spec 6.

- [ ] **Step 4: Verify and commit**

```bash
npm run typecheck && npm run test && npm run lint
```

The dashboard sits behind an OAuth wall, so state in your report that this is verified by types, lint and query-level tests rather than a click-through.

```bash
git add -A
git commit -m "feat: signals browser

Ships before the competitor agent on purpose: an ingestion pipeline you
cannot see is undebuggable, and the first external run should land on a
surface that already works."
```

---

## The competitor agent needs its own plan

The competitor agent — feed discovery, fetching, watermarks, the batched relevance pass, the cron sweep, and source-health surfacing — is **not specified to an executable standard in this document, and deliberately so.**

I drafted it as four more tasks and cut them. They described what to build without showing the test code, which is exactly the defect that produced fix rounds on both under-specified tasks in spec 2. Padding them with invented tests would have hidden that rather than fixed it. The agent is the riskiest, most novel part of this spec and deserves a plan written against the real code the way Tasks 1–3 were.

Ship Tasks 1–3 first. The browser existing before the agent runs is a genuine advantage: the first external ingestion lands on a surface that already works instead of being debugged blind.

### Design decisions already settled, for that plan to build on

These came out of reading the codebase and are worth not re-deriving:

- **`finalUrl` on `PageResult`.** `fetchPageText` follows redirects manually and knows where it landed, then discards it. Signals need canonical URLs and links must resolve against the page actually fetched. Adding it now is small; after agents depend on the current shape it is breaking. **The same-origin check in `crawlCompanySite` must keep anchoring on the *requested* URL** — spec 2's review confirmed that is what stops a homepage redirecting to a hostile host from steering the crawl onto that host's links. `finalUrl` is for recording and relative resolution, never for the origin decision.
- **Feeds beat scraping.** Most changelogs and blogs publish RSS/Atom, giving real ids, titles and dates. Autodiscover via `<link rel="alternate">`, prefer the feed, fall back to HTML plus a content hash. Use a parser — hand-rolling XML with regexes is how spec 2's ReDoS happened. `fast-xml-parser` is the candidate, and it is the one new dependency this spec would add.
- **Never invent a date.** An unparseable feed date becomes null, not `now`. Spec 5's ranking decays on `occurredAt`, so a fabricated timestamp makes every old entry look fresh.
- **Path matching must be by segment, not substring.** Spec 2's `rank()` uses `path.includes()`, which its own review flagged: `/blog/why-we-left-jira` scores as a blog index. Source discovery needs segment-exact matching. Write a new ranker; leave `crawl-company-site.ts` alone, since its substring matching is harmless for a one-shot bootstrap and changing it is out of scope.
- **The relevance pass is batched, and there is no precedent to copy.** `enrichChangeItem` is per-item. One `generateObject` call scores a run's surviving items, numbered, and **results are matched back by an explicit `index` field, not by array position** — a model that reorders or omits one must not misattribute a score. An item with no returned score is a scoring failure, not a zero.
- **Scoring fails open, and records the failure.** A classifier error writes the signal with a null `relevanceScore` and a rationale saying so. A missed competitor move is invisible; an unscored row announces itself. This is distinct from *below the floor*, where the item is genuinely never written — which is also why `listSignals` keeps null-scored rows when a minimum is set.
- **A new `RELEVANCE_MODEL` env var**, defaulting to Haiku. `ONBOARDING_ANALYSIS_MODEL` already drives two operations; a third under the same variable would make per-operation tuning impossible. Add `"signal_relevance"` to the `LlmOperation` union.
- **The sweep copies `resolve-sweep.ts`'s posture exactly**: iterate per tenant, each in its own try/catch, log and continue, never throw. One tenant's broken feed must not stop every other tenant's ingestion.
- **Sources rot silently.** `status`, `lastSuccessAt` and `lastError` exist on the table from Task 1 precisely so a dead source surfaces in settings rather than failing quietly for weeks. Surfacing them is part of the agent's plan, not an extra.

## Definition of done

- `npm run typecheck`, `npm run test`, and `npm run lint` all pass.
- Existing atomic updates appear as `shipped_work` signals; hiding one withdraws its signal and unhiding restores it.
- The signals browser lists, filters, and shows unscored signals distinctly from low-scored ones.
- `listSignals` returns only signals created within the last 60 days, and unscored signals survive a minimum-score filter.

## Notes for spec 4 and spec 5

- **Spec 4 (news agent)** reuses `sources` with `type: "news"` and a null `url`, searching against `companyProfiles.topics`. `scoreRelevance` is shared as-is; only acquisition differs.
- **Deletion is deferred, not cancelled.** Whoever builds it must use `SIGNAL_WINDOW_DAYS` and `createdAt` from `src/lib/signals/window.ts`, and must exempt signals cited by an ACCEPTED brief — those are the evidence trail behind published content, and `brief_signals` will cascade on signal delete. Nothing is at risk until spec 5 creates that join, which is exactly why deferring deletion past it is safe.
- **`signals.status = 'used'` is not a consumption gate.** Ideation reads every signal in its window regardless of status.
