# Brief Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent-proposed briefs reachable by a human — read them, accept one into a content piece, or dismiss it with a reason that trains the next run.

**Architecture:** A `brief_runs` table records every ideation run so an empty inbox can distinguish "nothing was worth saying" from "the agent is broken". A `query.ts` module reads briefs with their cited signals. A `/briefs` route mirrors the existing signals browser. Accept creates a content piece with a deterministic scaffold body — no model call; real drafting is spec 5c.

**Tech Stack:** Next.js 16 App Router, React Server Components, Drizzle ORM 0.45.2, Postgres, Vitest, Tailwind.

**Spec:** `docs/superpowers/specs/2026-08-06-brief-inbox-design.md`

## Global Constraints

- **This is NOT the Next.js you know.** Read the relevant guide in `node_modules/next/dist/docs/` before writing App Router code. In Next.js 16 a page's `searchParams` and a route's `params` are **Promises and must be awaited**. See `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`.
- **The tests are the contract. If prose and a code sample in this plan disagree, STOP and report it.** Do not guess which is right.
- **A comment that promises behaviour the code does not implement is a bug.**
- **Never hardcode a value a constant already expresses.** Derive test fixtures from exported constants.
- **When you add a test to guard a behaviour, delete the guard and confirm the test fails.** Then confirm it passes for reasons that hold in a full parallel run.
- **After any schema change run BOTH `npm run db:migrate:test` and `npm run db:migrate`.** Skipping the second previously caused a `42P10` misdiagnosed as a code defect.
- **Every query touching briefs MUST be tenant-scoped.** Briefs contain the company's unpublished content strategy. A brief id arriving from a URL is user-supplied and must be re-read scoped to the session's tenant.
- Tests run against a database whose name ends in `_test`; `npm run test` enforces this.
- The suite is FLAKY — ~157 files against one shared Postgres. A failure in a file this plan did not touch is pre-existing: report it, do not fix it.
- Commit after each task. Do NOT push. Do NOT merge.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/db/schema.ts` | `briefRuns` table; `contentPieceId` FK | 1 |
| `src/db/migrations/*.sql` | generated | 1 |
| `src/lib/briefs/run.ts` | `recordRun` at both exits | 2 |
| `src/lib/briefs/query.ts` | `listBriefs`, `latestBriefRun` | 3 |
| `src/app/(dashboard)/briefs/actions.ts` | `acceptBrief`, `dismissBrief`, `scaffoldBody` | 4 |
| `src/app/(dashboard)/briefs/page.tsx` + `briefs-list` + `brief-card` + `briefs-filters` | the inbox | 5 |
| `src/app/(dashboard)/nav-links.tsx` | a `/briefs` entry | 5 |

**Already exists — do NOT re-add:** `briefs_content_piece_unique` (partial unique index on `contentPieceId` where not null, `schema.ts:487-490`) and `briefs_tenant_status_score_idx` on `(tenantId, status, score)`. Only the foreign key is missing, and no new read index is needed.

**Task 1 must also modify `tests/db/briefs-schema.test.ts`.** That file inserts a random UUID as `contentPieceId` to exercise the partial unique index, on the stated grounds that "contentPieceId has no FK in this plan". Adding the FK makes that insert fail with `23503` — and the failure lands on the FIRST insert, so the duplicate assertion the test exists for is never reached and the index's coverage disappears silently. It must insert a real `contentPieces` row instead, and the stale comment must be corrected. This omission was found only after Task 1 was reviewed and marked complete.

---

### Task 1: `brief_runs` table and the `contentPieceId` foreign key

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/<generated>.sql`
- Test: `tests/lib/briefs/brief-runs.test.ts`

**Interfaces:**
- Produces: `briefRuns` table with columns `id`, `tenantId`, `ranAt`, `assessment`, `briefsCreated`, `briefsExtended`, `error`; and `briefs.contentPieceId` referencing `contentPieces.id` with `ON DELETE SET NULL`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/briefs/brief-runs.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, briefs, briefRuns, contentPieces } from "../../../src/db/schema";

const TENANT = "Brief Runs Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

describe("briefRuns", () => {
  it("records a run that produced nothing and explains why", async () => {
    const tenant = await seedTenant();
    await db.insert(briefRuns).values({
      tenantId: tenant.id,
      assessment: "A quiet week — only maintenance work shipped.",
      briefsCreated: 0,
      briefsExtended: 0,
    });

    const [row] = await db.select().from(briefRuns).where(eq(briefRuns.tenantId, tenant.id));
    // The whole point of the table: a zero-brief run still carries a reason.
    expect(row.briefsCreated).toBe(0);
    expect(row.assessment).toContain("quiet week");
    expect(row.error).toBeNull();
    expect(row.ranAt).toBeInstanceOf(Date);
  });

  it("records a failed run with its error and no assessment", async () => {
    const tenant = await seedTenant();
    await db.insert(briefRuns).values({ tenantId: tenant.id, error: "model timeout" });

    const [row] = await db.select().from(briefRuns).where(eq(briefRuns.tenantId, tenant.id));
    expect(row.error).toBe("model timeout");
    expect(row.assessment).toBeNull();
  });

  it("drops a tenant's runs when the tenant is deleted", async () => {
    const tenant = await seedTenant();
    await db.insert(briefRuns).values({ tenantId: tenant.id });
    await db.delete(tenants).where(eq(tenants.id, tenant.id));

    const rows = await db.select().from(briefRuns).where(eq(briefRuns.tenantId, tenant.id));
    expect(rows).toHaveLength(0);
  });
});

describe("briefs.contentPieceId", () => {
  it("nulls the link when the content piece is deleted, keeping the brief", async () => {
    const tenant = await seedTenant();
    const [piece] = await db
      .insert(contentPieces)
      .values({ tenantId: tenant.id, type: "blog_post", title: "P", body: "b" })
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
        score: 0.8,
        status: "accepted",
        contentPieceId: piece.id,
        lastEvidenceAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .returning();

    await db.delete(contentPieces).where(eq(contentPieces.id, piece.id));

    // SET NULL, not cascade: the brief is the durable record that a human
    // accepted something. Deleting the draft must not erase that decision.
    const [after] = await db.select().from(briefs).where(eq(briefs.id, brief.id));
    expect(after).toBeDefined();
    expect(after.contentPieceId).toBeNull();
    expect(after.status).toBe("accepted");
  });
});
```

**Verified for you:** `briefOriginEnum` is `["agent", "manual"]` (`schema.ts:416`), so `origin: "agent"` above is correct. `briefs` has **two** NOT NULL timestamp columns with no default — `lastEvidenceAt` (`schema.ts:477`) and `expiresAt` (`schema.ts:478`) — and every fixture in this plan sets both. Every existing brief test in the repo does the same; a fixture missing either fails with a `23502` not-null violation, not a clear error.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/lib/briefs/brief-runs.test.ts
```

Expected: FAIL — `briefRuns` is not exported from `src/db/schema.ts`.

- [ ] **Step 3: Add the table**

At the end of `src/db/schema.ts`:

```typescript
/**
 * One row per ideation run, whatever the outcome.
 *
 * Exists because of the failure this codebase already named at
 * `src/lib/briefs/run.ts:213` — a permanently broken ideation is
 * "indistinguishable from a genuinely quiet company: the cron reports ok, no
 * brief appears, and nothing is written anywhere." This table is the
 * "anywhere". The inbox reads the latest row so an empty inbox can say which
 * of the two it is.
 *
 * The assessment lives HERE and not on `briefs` on purpose: it describes a
 * run, not a brief, and denormalising it onto each brief would mean a run that
 * produced zero briefs carries no assessment at all — precisely the case worth
 * explaining.
 *
 * No retention is enforced. At one row per tenant per day this is ~365 rows a
 * year; `ranAt` is stored so a purge can be added later without a migration.
 */
export const briefRuns = pgTable(
  "brief_runs",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
    // The model's one-line judgement of the period. Null when the call failed —
    // there is no judgement to record, and a placeholder string would read as one.
    assessment: text("assessment"),
    briefsCreated: integer("briefs_created").notNull().default(0),
    briefsExtended: integer("briefs_extended").notNull().default(0),
    // Null on a clean run. Carries the ideation error, which `runIdeation`
    // otherwise only writes to console.
    error: text("error"),
  },
  (table) => [
    // The inbox reads exactly one row: this tenant's most recent.
    index("brief_runs_tenant_ran_at_idx").on(table.tenantId, table.ranAt),
  ]
);

export type BriefRun = typeof briefRuns.$inferSelect;
```

- [ ] **Step 4: Add the foreign key to `briefs.contentPieceId`**

Replace the existing column definition (`schema.ts:461-463`, currently carrying a comment saying the reference was withheld):

```typescript
    // The accepted brief's content piece. SET NULL rather than cascade: the
    // brief is the durable record that a human accepted something, and deleting
    // the draft must not erase that decision.
    //
    // Uniqueness is already enforced by `briefs_content_piece_unique` below —
    // do NOT add another index.
    contentPieceId: uuid("content_piece_id").references(() => contentPieces.id, {
      onDelete: "set null",
    }),
```

`contentPieces` is declared later in the file than `briefs`; the arrow-function reference is lazy, so ordering is not a problem.

- [ ] **Step 5: Generate and apply the migration**

```bash
npm run db:generate
```

Then apply to **both** databases:

```bash
npm run db:migrate:test && npm run db:migrate
```

If drizzle-kit asks anything interactive, stop and report rather than guessing.

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run tests/lib/briefs/brief-runs.test.ts
npm run typecheck
```

Expected: PASS, 4 tests; typecheck clean.

- [ ] **Step 7: Prove the SET NULL guard bites**

The guard lives in the **database**, not in TypeScript. Editing the Drizzle
schema proves nothing once the constraint exists, and regenerating the
migration to flip it would leave two junk migration files behind. Alter the
live constraint on the TEST database instead.

First find the constraint's real name (do not assume Drizzle's naming):

```bash
DATABASE_URL="${TEST_DATABASE_URL:-postgresql://postgres:postgres@localhost:5433/product_announcer_test}" \
  npx tsx -e "import('./src/db').then(async ({db})=>{const {sql}=await import('drizzle-orm');const r=await db.execute(sql\`SELECT conname FROM pg_constraint WHERE conrelid='briefs'::regclass AND contype='f' AND conname LIKE '%content_piece%'\`);console.log(r.rows??r);process.exit(0)})"
```

**Confirm `DATABASE_URL` names a database ending in `_test` before running any
DDL.** Then, using the name it printed, drop and recreate the constraint with
`ON DELETE CASCADE`, run the test — "nulls the link when the content piece is
deleted, keeping the brief" must FAIL because the brief row is gone — then
restore it with `ON DELETE SET NULL` and confirm green.

Paste both the failing and the restored output into your report. Create no
migration files during this step; `git status` must be clean of them afterwards.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/migrations tests/lib/briefs/brief-runs.test.ts
git commit -m "feat: add brief_runs and the briefs.content_piece_id foreign key"
```

---

### Task 2: Record every ideation run

**Files:**
- Modify: `src/lib/briefs/run.ts`
- Test: `tests/lib/briefs/run.test.ts` (existing file — add to it)

**Interfaces:**
- Consumes: `briefRuns` from Task 1.
- Produces: nothing exported. `runIdeation`'s signature and return type are UNCHANGED — do not add an `error` field to `IdeationRunResult`.

**Context:** `runIdeation` has exactly two exits after setup, verified by reading the function. There is no early return for an empty signal list — `ideate` returns `{ assessment: "No signals in the window.", actions: [] }` and that flows through the normal path.

| Exit | line | assessment | created | extended | error |
|---|---|---|---|---|---|
| Ideation failed | `run.ts:222` (`return empty`) | null | 0 | 0 | `outcome.error` |
| Normal | `run.ts:281` | `outcome.assessment` | `proposed` | `extended` | null |

- [ ] **Step 1: Write the failing tests**

Add to `tests/lib/briefs/run.test.ts`. Import `briefRuns` from the schema.

```typescript
  it("records a run row when ideation succeeds", async () => {
    const tenant = await seedTenant();
    const ideateFn = vi.fn().mockResolvedValue({
      assessment: "A quiet week — only maintenance shipped.",
      actions: [],
    });

    await runIdeation(tenant.id, { database: db, ideateFn });

    const rows = await db.select().from(briefRuns).where(eq(briefRuns.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].assessment).toContain("quiet week");
    expect(rows[0].briefsCreated).toBe(0);
    expect(rows[0].error).toBeNull();
  });

  it("records a run row carrying the error when ideation fails", async () => {
    const tenant = await seedTenant();
    const ideateFn = vi.fn().mockResolvedValue({ error: "model timeout" });

    await runIdeation(tenant.id, { database: db, ideateFn });

    const rows = await db.select().from(briefRuns).where(eq(briefRuns.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    // Without this the failure is invisible: runIdeation only console.errors it
    // and returns `empty`, so the error string never reaches a caller.
    expect(rows[0].error).toBe("model timeout");
    expect(rows[0].assessment).toBeNull();
    expect(rows[0].briefsCreated).toBe(0);
  });

  it("writes exactly one run row per call", async () => {
    const tenant = await seedTenant();
    const ideateFn = vi.fn().mockResolvedValue({ assessment: "ok", actions: [] });

    await runIdeation(tenant.id, { database: db, ideateFn });
    await runIdeation(tenant.id, { database: db, ideateFn });

    const rows = await db.select().from(briefRuns).where(eq(briefRuns.tenantId, tenant.id));
    expect(rows).toHaveLength(2);
  });
```

Match the existing file's seeding helpers rather than inventing new ones — read the top of `tests/lib/briefs/run.test.ts` first and reuse `seedTenant` as it is defined there.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run tests/lib/briefs/run.test.ts -t "run row"
```

Expected: FAIL — no rows written.

- [ ] **Step 3: Add the helper**

Import `briefRuns` in `src/lib/briefs/run.ts` and add near the other module-private helpers:

```typescript
/**
 * Records the outcome of one ideation run.
 *
 * Never throws. A failed bookkeeping write must not cost a run its briefs, so
 * the failure is logged and the run continues — the worst case is a missing
 * row, which is the behaviour that existed before this table.
 */
async function recordRun(
  database: typeof defaultDb,
  tenantId: string,
  fields: { assessment: string | null; created: number; extended: number; error: string | null }
): Promise<void> {
  try {
    await database.insert(briefRuns).values({
      tenantId,
      assessment: fields.assessment,
      briefsCreated: fields.created,
      briefsExtended: fields.extended,
      error: fields.error,
    });
  } catch (e) {
    console.error(`[ideation] could not record run for tenant ${tenantId}:`, e);
  }
}
```

- [ ] **Step 4: Call it at both exits**

At the failure exit (currently `run.ts:213-222`) — keep the existing `console.error`, which is a log, not a substitute for the row:

```typescript
  if ("error" in outcome) {
    console.error(`[ideation] failed for tenant ${tenantId}:`, outcome.error);
    await recordRun(database, tenantId, {
      assessment: null,
      created: 0,
      extended: 0,
      error: outcome.error,
    });
    return empty;
  }
```

At the normal exit (currently `run.ts:281`):

```typescript
  await recordRun(database, tenantId, {
    assessment: outcome.assessment,
    created: proposed,
    extended,
    error: null,
  });

  return { proposed, extended, assessment: outcome.assessment };
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run tests/lib/briefs/run.test.ts
npm run typecheck
```

Expected: PASS, whole file.

- [ ] **Step 6: Prove the error-path guard bites**

Temporarily change the failure exit's `error: outcome.error` to `error: null`. The test "records a run row carrying the error when ideation fails" must FAIL. Restore and re-run.

- [ ] **Step 7: Commit**

```bash
git add src/lib/briefs/run.ts tests/lib/briefs/run.test.ts
git commit -m "feat: record every ideation run, including its failures"
```

---

### Task 3: The brief read path

**Files:**
- Create: `src/lib/briefs/query.ts`
- Test: `tests/lib/briefs/query.test.ts`

**Interfaces:**
- Consumes: `briefRuns` (Task 1).
- Produces:
```typescript
export type BriefFilters = { status?: Brief["status"] };
export type CitedSignal = { id: string; title: string; url: string | null; kind: Signal["kind"] };
export type BriefWithSignals = Brief & { signals: CitedSignal[] };
export async function listBriefs(tenantId: string, filters: BriefFilters, database?: typeof defaultDb): Promise<BriefWithSignals[]>
export async function latestBriefRun(tenantId: string, database?: typeof defaultDb): Promise<BriefRun | null>
```

- [ ] **Step 1: Write the failing test**

Create `tests/lib/briefs/query.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, briefs, briefSignals, signals, briefRuns } from "../../../src/db/schema";
import { listBriefs, latestBriefRun } from "../../../src/lib/briefs/query";

const TENANT = "Brief Query Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

async function seedBrief(
  tenantId: string,
  overrides: Partial<typeof briefs.$inferInsert> = {}
) {
  const [brief] = await db
    .insert(briefs)
    .values({
      tenantId,
      origin: "agent",
      contentType: "blog_post",
      title: "A title",
      angle: "An angle",
      whyNow: "Because",
      suggestedChannel: "blog",
      score: 0.8,
      lastEvidenceAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      ...overrides,
    })
    .returning();
  return brief;
}

describe("listBriefs", () => {
  it("returns only the calling tenant's briefs", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    await seedBrief(mine.id, { title: "Mine" });
    await seedBrief(other.id, { title: "Theirs" });

    const rows = await listBriefs(mine.id, {}, db);
    expect(rows.map((b) => b.title)).toEqual(["Mine"]);
  });

  it("defaults to new briefs only", async () => {
    const tenant = await seedTenant();
    await seedBrief(tenant.id, { title: "Open", status: "new" });
    await seedBrief(tenant.id, { title: "Gone", status: "dismissed" });

    const rows = await listBriefs(tenant.id, {}, db);
    expect(rows.map((b) => b.title)).toEqual(["Open"]);
  });

  it("reaches decided briefs through the status filter", async () => {
    const tenant = await seedTenant();
    await seedBrief(tenant.id, { title: "Open", status: "new" });
    await seedBrief(tenant.id, { title: "Gone", status: "dismissed" });

    const rows = await listBriefs(tenant.id, { status: "dismissed" }, db);
    expect(rows.map((b) => b.title)).toEqual(["Gone"]);
  });

  it("orders by score, then recency", async () => {
    const tenant = await seedTenant();
    // Two briefs share a score. The spike measured scores clustering at
    // 0.66-0.92, so score alone cannot order a real backlog — recency is what
    // breaks the ties, and this fixture is the tie.
    const older = await seedBrief(tenant.id, { title: "Older", score: 0.8 });
    await new Promise((r) => setTimeout(r, 10));
    const newer = await seedBrief(tenant.id, { title: "Newer", score: 0.8 });
    await seedBrief(tenant.id, { title: "Best", score: 0.95 });

    const rows = await listBriefs(tenant.id, {}, db);
    expect(rows.map((b) => b.title)).toEqual(["Best", "Newer", "Older"]);
    expect(newer.createdAt.getTime()).toBeGreaterThan(older.createdAt.getTime());
  });

  it("attaches the cited signals", async () => {
    const tenant = await seedTenant();
    const brief = await seedBrief(tenant.id);
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        kind: "market_news",
        externalId: "https://a.example.com/x",
        url: "https://a.example.com/x",
        title: "The evidence",
        occurredAt: new Date(),
      })
      .returning();
    await db.insert(briefSignals).values({ briefId: brief.id, signalId: signal.id });

    const [row] = await listBriefs(tenant.id, {}, db);
    // The evidence is the point: it is what lets a human tell reasoning from
    // confabulation before accepting.
    expect(row.signals).toHaveLength(1);
    expect(row.signals[0].title).toBe("The evidence");
    expect(row.signals[0].url).toBe("https://a.example.com/x");
  });

  it("returns an empty signal list rather than omitting an uncited brief", async () => {
    const tenant = await seedTenant();
    await seedBrief(tenant.id, { title: "Uncited" });

    const rows = await listBriefs(tenant.id, {}, db);
    // An inner join would silently drop briefs with no evidence rows.
    expect(rows).toHaveLength(1);
    expect(rows[0].signals).toEqual([]);
  });
});

describe("latestBriefRun", () => {
  it("returns the most recent run for the tenant", async () => {
    const tenant = await seedTenant();
    await db.insert(briefRuns).values({
      tenantId: tenant.id,
      assessment: "old",
      ranAt: new Date(Date.now() - 86_400_000),
    });
    await db.insert(briefRuns).values({ tenantId: tenant.id, assessment: "new" });

    const run = await latestBriefRun(tenant.id, db);
    expect(run?.assessment).toBe("new");
  });

  it("returns null when the agent has never run", async () => {
    const tenant = await seedTenant();
    expect(await latestBriefRun(tenant.id, db)).toBeNull();
  });

  it("does not read another tenant's run", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    await db.insert(briefRuns).values({ tenantId: other.id, assessment: "theirs" });

    expect(await latestBriefRun(mine.id, db)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/lib/briefs/query.test.ts
```

Expected: FAIL — `src/lib/briefs/query.ts` does not exist.

- [ ] **Step 3: Write the module**

Create `src/lib/briefs/query.ts`:

```typescript
import { and, desc, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { briefRuns, briefSignals, briefs, signals, type Brief, type BriefRun, type Signal } from "@/db/schema";

export type BriefFilters = { status?: Brief["status"] };

export type CitedSignal = { id: string; title: string; url: string | null; kind: Signal["kind"] };

export type BriefWithSignals = Brief & { signals: CitedSignal[] };

/**
 * Tenant-scoped brief listing for the inbox.
 *
 * Ordered by score AND recency. The validation spike measured scores
 * clustering at 0.66-0.92 (see the comment on `briefs.score`), so score alone
 * cannot order a real backlog — recency breaks the ties it leaves.
 *
 * Defaults to `new`. Accepted, dismissed and expired briefs are decisions
 * already made and are reachable only by asking for them.
 *
 * Evidence is fetched in a SECOND query rather than joined, so a brief cited by
 * five signals stays one row. It is also a LEFT relationship in effect: a brief
 * with no evidence still appears, with an empty array.
 */
export async function listBriefs(
  tenantId: string,
  filters: BriefFilters,
  database: typeof defaultDb = defaultDb
): Promise<BriefWithSignals[]> {
  const rows = await database
    .select()
    .from(briefs)
    .where(and(eq(briefs.tenantId, tenantId), eq(briefs.status, filters.status ?? "new")))
    .orderBy(desc(briefs.score), desc(briefs.createdAt));

  if (rows.length === 0) return [];

  const links = await database
    .select({
      briefId: briefSignals.briefId,
      id: signals.id,
      title: signals.title,
      url: signals.url,
      kind: signals.kind,
    })
    .from(briefSignals)
    .innerJoin(signals, eq(signals.id, briefSignals.signalId))
    .where(
      inArray(
        briefSignals.briefId,
        rows.map((r) => r.id)
      )
    );

  const byBrief = new Map<string, CitedSignal[]>();
  for (const link of links) {
    const list = byBrief.get(link.briefId) ?? [];
    list.push({ id: link.id, title: link.title, url: link.url, kind: link.kind });
    byBrief.set(link.briefId, list);
  }

  return rows.map((r) => ({ ...r, signals: byBrief.get(r.id) ?? [] }));
}

/**
 * This tenant's most recent ideation run, or null if the agent has never run.
 *
 * The inbox header reads this so an empty list can say WHICH empty it is: never
 * run, ran and judged the period quiet, or ran and failed. Without it those
 * three render identically — the failure `run.ts:213` already warns about.
 */
export async function latestBriefRun(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<BriefRun | null> {
  const [row] = await database
    .select()
    .from(briefRuns)
    .where(eq(briefRuns.tenantId, tenantId))
    .orderBy(desc(briefRuns.ranAt))
    .limit(1);
  return row ?? null;
}
```

**Verified for you:** `Signal` (`schema.ts:414`) and `Brief` (`schema.ts:494`) are both exported under exactly those names. `BriefRun` is exported by Task 1.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/lib/briefs/query.test.ts
npm run typecheck
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Prove two guards bite**

1. Change the evidence query's `innerJoin` usage so uncited briefs are dropped — replace the final `rows.map(...)` with `rows.filter((r) => byBrief.has(r.id)).map(...)`. The test "returns an empty signal list rather than omitting an uncited brief" must FAIL.
2. Remove `desc(briefs.createdAt)` from the `orderBy`. The test "orders by score, then recency" must FAIL (or become order-dependent — if it still passes, the fixture is not actually creating a tie and you must say so in your report).

Restore both and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/lib/briefs/query.ts tests/lib/briefs/query.test.ts
git commit -m "feat: add the brief inbox read path"
```

---

### Task 4: Accept and dismiss

**Files:**
- Create: `src/app/(dashboard)/briefs/actions.ts`
- Test: `tests/app/briefs-actions.test.ts`

**Interfaces:**
- Consumes: `briefs`, `contentPieces` from the schema.
- Produces:
```typescript
export type DismissReason = NonNullable<Brief["dismissReason"]>;
export type AcceptResult = { ok: true; contentPieceId: string } | { ok: false; error: string };
export type DismissResult = { ok: true } | { ok: false; error: string };
export function scaffoldBody(brief: { angle: string; whyNow: string; keyPoints: string[] }): string
export async function acceptBrief(briefId: string): Promise<AcceptResult>
export async function dismissBrief(briefId: string, reason: DismissReason, note?: string): Promise<DismissResult>
```

**These actions do NOT redirect.** `acceptBrief` returns the new `contentPieceId` and the client navigates. `redirect()` throws a control-flow exception, which would make every test assert on a thrown error instead of a result.

- [ ] **Step 1: Write the failing test**

Create `tests/app/briefs-actions.test.ts`, following `tests/app/change-events-actions.test.ts`'s mocking pattern:

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, briefs, contentPieces } from "../../src/db/schema";

const TENANT = "Briefs Actions Test Tenant";
let currentTenantId = "";
let currentUserId: string | null = null;

// requireSession() returns a NextAuth Session — tenantId lives under `user`,
// per src/types/next-auth.d.ts. Mirror that shape, not a flat one.
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { acceptBrief, dismissBrief, scaffoldBody } from "../../src/app/(dashboard)/briefs/actions";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  vi.clearAllMocks();
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  currentTenantId = tenant.id;
  return tenant;
}

async function seedBrief(tenantId: string, overrides: Partial<typeof briefs.$inferInsert> = {}) {
  const [brief] = await db
    .insert(briefs)
    .values({
      tenantId,
      origin: "agent",
      contentType: "blog_post",
      title: "How localization breaks design systems",
      angle: "Most teams discover it too late",
      whyNow: "Two competitors shipped multilingual tooling this month",
      suggestedChannel: "blog",
      keyPoints: ["Point one", "Point two"],
      score: 0.8,
      lastEvidenceAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      ...overrides,
    })
    .returning();
  return brief;
}

describe("scaffoldBody", () => {
  it("includes the angle, the why-now and every key point", () => {
    const body = scaffoldBody({ angle: "A", whyNow: "W", keyPoints: ["One", "Two"] });
    expect(body).toContain("A");
    expect(body).toContain("W");
    expect(body).toContain("## One");
    expect(body).toContain("## Two");
  });

  it("produces a non-empty body when there are no key points", () => {
    // contentPieces.body is NOT NULL — an empty scaffold would fail the insert.
    expect(scaffoldBody({ angle: "A", whyNow: "W", keyPoints: [] }).trim().length).toBeGreaterThan(0);
  });
});

describe("acceptBrief", () => {
  it("creates one content piece and links it both ways", async () => {
    const tenant = await seedTenant();
    currentUserId = null;
    const brief = await seedBrief(tenant.id);

    const result = await acceptBrief(brief.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const pieces = await db.select().from(contentPieces).where(eq(contentPieces.tenantId, tenant.id));
    expect(pieces).toHaveLength(1);
    expect(pieces[0].id).toBe(result.contentPieceId);
    expect(pieces[0].type).toBe("blog_post");
    expect(pieces[0].status).toBe("draft");
    expect(pieces[0].body).toContain("## Point one");

    const [after] = await db.select().from(briefs).where(eq(briefs.id, brief.id));
    expect(after.status).toBe("accepted");
    expect(after.contentPieceId).toBe(result.contentPieceId);
    expect(after.acceptedAt).toBeInstanceOf(Date);
  });

  it("refuses a brief belonging to another tenant and creates nothing", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const theirs = await seedBrief(other.id);

    // currentTenantId is `mine`. The id came from a URL and is user-supplied;
    // briefs carry the company's unpublished content strategy.
    const result = await acceptBrief(theirs.id);
    expect(result.ok).toBe(false);

    const pieces = await db.select().from(contentPieces).where(eq(contentPieces.tenantId, mine.id));
    expect(pieces).toHaveLength(0);
    const [untouched] = await db.select().from(briefs).where(eq(briefs.id, theirs.id));
    expect(untouched.status).toBe("new");
  });

  it("is a no-op on an already-accepted brief, not a second content piece", async () => {
    const tenant = await seedTenant();
    const brief = await seedBrief(tenant.id);

    await acceptBrief(brief.id);
    const second = await acceptBrief(brief.id);

    expect(second.ok).toBe(false);
    const pieces = await db.select().from(contentPieces).where(eq(contentPieces.tenantId, tenant.id));
    expect(pieces).toHaveLength(1);
  });

  it("leaves no orphan content piece when the brief cannot be transitioned", async () => {
    const tenant = await seedTenant();
    const brief = await seedBrief(tenant.id, { status: "dismissed" });

    const result = await acceptBrief(brief.id);
    expect(result.ok).toBe(false);
    const pieces = await db.select().from(contentPieces).where(eq(contentPieces.tenantId, tenant.id));
    expect(pieces).toHaveLength(0);
  });
});

describe("dismissBrief", () => {
  it("writes every dismissal column", async () => {
    const tenant = await seedTenant();
    currentUserId = null;
    const brief = await seedBrief(tenant.id);

    const result = await dismissBrief(brief.id, "already_covered", "We shipped this last week.");
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(briefs).where(eq(briefs.id, brief.id));
    expect(after.status).toBe("dismissed");
    expect(after.dismissReason).toBe("already_covered");
    expect(after.dismissNote).toBe("We shipped this last week.");
    expect(after.dismissedAt).toBeInstanceOf(Date);
  });

  it("refuses a brief belonging to another tenant", async () => {
    await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const theirs = await seedBrief(other.id);

    const result = await dismissBrief(theirs.id, "off_topic");
    expect(result.ok).toBe(false);
    const [untouched] = await db.select().from(briefs).where(eq(briefs.id, theirs.id));
    expect(untouched.status).toBe("new");
  });

  it("is a no-op on a brief that was already decided", async () => {
    const tenant = await seedTenant();
    const brief = await seedBrief(tenant.id, { status: "accepted" });

    const result = await dismissBrief(brief.id, "off_topic");
    expect(result.ok).toBe(false);
    const [after] = await db.select().from(briefs).where(eq(briefs.id, brief.id));
    expect(after.status).toBe("accepted");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/app/briefs-actions.test.ts
```

Expected: FAIL — the actions module does not exist.

- [ ] **Step 3: Write the actions**

Create `src/app/(dashboard)/briefs/actions.ts`:

```typescript
"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { briefs, contentPieces, type Brief } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";

export type DismissReason = NonNullable<Brief["dismissReason"]>;
export type AcceptResult = { ok: true; contentPieceId: string } | { ok: false; error: string };
export type DismissResult = { ok: true } | { ok: false; error: string };

/**
 * The starting body for an accepted brief.
 *
 * Deterministic and model-free on purpose: real drafting is spec 5c, and
 * `contentPieces.body` is NOT NULL so something has to be written. Key points
 * become headings because they ARE the outline — the schema deliberately has no
 * separate `outline` column.
 */
export function scaffoldBody(brief: { angle: string; whyNow: string; keyPoints: string[] }): string {
  return [brief.angle, "", `Why now: ${brief.whyNow}`, "", ...brief.keyPoints.map((p) => `## ${p}`)]
    .join("\n")
    .trim();
}

/**
 * Re-reads a brief scoped to the caller's tenant.
 *
 * The id arrives from a URL and is user-supplied, and briefs carry the
 * company's unpublished content strategy — so this is a membership check, not a
 * convenience. Returning null for "not yours" and "does not exist" alike also
 * avoids confirming that another tenant's brief exists.
 */
async function loadOwnBrief(briefId: string, tenantId: string): Promise<Brief | null> {
  const [brief] = await db
    .select()
    .from(briefs)
    .where(and(eq(briefs.id, briefId), eq(briefs.tenantId, tenantId)));
  return brief ?? null;
}

export async function acceptBrief(briefId: string): Promise<AcceptResult> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;

  const brief = await loadOwnBrief(briefId, tenantId);
  if (!brief) return { ok: false, error: "Brief not found." };
  if (brief.status !== "new") return { ok: false, error: `This brief was already ${brief.status}.` };

  let contentPieceId: string;
  try {
    contentPieceId = await db.transaction(async (tx) => {
      const [piece] = await tx
        .insert(contentPieces)
        .values({
          tenantId,
          type: brief.contentType,
          title: brief.title,
          body: scaffoldBody(brief),
          status: "draft",
        })
        .returning({ id: contentPieces.id });

      // `status = "new"` is repeated here deliberately. The check above ran in a
      // separate statement, so two clicks can both pass it; this makes the
      // transition itself the race winner, and a loser rolls back rather than
      // leaving an orphan content piece behind.
      const updated = await tx
        .update(briefs)
        .set({
          status: "accepted",
          acceptedBy: session.user.id ?? null,
          acceptedAt: new Date(),
          contentPieceId: piece.id,
        })
        .where(and(eq(briefs.id, briefId), eq(briefs.status, "new")))
        .returning({ id: briefs.id });

      if (updated.length === 0) tx.rollback();
      return piece.id;
    });
  } catch {
    return { ok: false, error: "This brief was already accepted." };
  }

  revalidatePath("/briefs");
  return { ok: true, contentPieceId };
}

export async function dismissBrief(
  briefId: string,
  reason: DismissReason,
  note?: string
): Promise<DismissResult> {
  const session = await requireSession();
  const tenantId = session.user.tenantId;

  const brief = await loadOwnBrief(briefId, tenantId);
  if (!brief) return { ok: false, error: "Brief not found." };
  if (brief.status !== "new") return { ok: false, error: `This brief was already ${brief.status}.` };

  // These columns are not just an audit trail: `run.ts:163-200` reads dismissed
  // briefs back into the next run's prompt as `rejected`, so writing them is
  // what makes a dismissal train the agent.
  const updated = await db
    .update(briefs)
    .set({
      status: "dismissed",
      dismissReason: reason,
      dismissNote: note?.trim() ? note.trim() : null,
      dismissedBy: session.user.id ?? null,
      dismissedAt: new Date(),
    })
    .where(and(eq(briefs.id, briefId), eq(briefs.status, "new")))
    .returning({ id: briefs.id });

  if (updated.length === 0) return { ok: false, error: "This brief was already decided." };

  revalidatePath("/briefs");
  return { ok: true };
}
```

`tx.rollback()` throws a `TransactionRollbackError` that propagates out of `db.transaction`, which is why the call is wrapped. If Drizzle 0.45.2's rollback behaves differently, STOP and report rather than working around it.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/app/briefs-actions.test.ts
npm run typecheck
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Prove the two security guards bite**

1. In `loadOwnBrief`, remove `eq(briefs.tenantId, tenantId)` from the `where`. Both "refuses a brief belonging to another tenant" tests must FAIL.
2. Remove `eq(briefs.status, "new")` from `acceptBrief`'s UPDATE `where`. "is a no-op on an already-accepted brief" must still pass (the pre-check catches it) — but note in your report whether it does, because that tells you the race guard is untested by the suite and only the pre-check is.

Restore both and re-run.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/briefs/actions.ts" tests/app/briefs-actions.test.ts
git commit -m "feat: accept and dismiss briefs"
```

---

### Task 5: The inbox UI

**Files:**
- Create: `src/app/(dashboard)/briefs/page.tsx`, `briefs-list.tsx`, `brief-card.tsx`, `briefs-filters.tsx`
- Modify: `src/app/(dashboard)/nav-links.tsx`

**Interfaces:**
- Consumes: `listBriefs`, `latestBriefRun` (Task 3); `acceptBrief`, `dismissBrief`, `DismissReason` (Task 4).

**Read first:** `src/app/(dashboard)/signals/page.tsx` and its `signals-list.tsx` / `signals-filters.tsx`. Match their structure, imports and component conventions rather than inventing new ones. Reuse `@/components/ui/*` (`Badge`, `Button`, `EmptyState` and friends) — do not write new primitives.

- [ ] **Step 1: Build the page**

`page.tsx` is an async Server Component. In Next.js 16 `searchParams` is a **Promise and must be awaited** — see `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`, and copy the pattern from `signals/page.tsx`, which documents this in its own comment.

```typescript
export default async function BriefsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const status = parseStatus(single(params.status));

  const [briefs, latestRun] = await Promise.all([
    listBriefs(session.user.tenantId, { status }, db),
    latestBriefRun(session.user.tenantId, db),
  ]);
  // ...header, filters, list
}
```

`parseStatus` must accept only the four `briefStatusEnum` members and return `undefined` otherwise — an unrecognised `?status=` value must fall back to the default, never reach the query. `single` already exists in `src/lib/signals/params.ts`; reuse it rather than reimplementing.

- [ ] **Step 2: Build the header and the three empty states**

The header renders `latestRun`: relative time, the assessment, the counts, and the error if present.

The empty state must distinguish three cases — this is the entire reason `brief_runs` exists:

| Condition | Message |
|---|---|
| `latestRun === null` | The agent has not run yet. It runs daily. |
| `latestRun.error` | The last run failed — show `latestRun.error`. |
| otherwise | Show `latestRun.assessment`, i.e. the agent ran and judged there was nothing worth writing. |

A single generic "No briefs" message for all three is a defect, not a simplification.

- [ ] **Step 3: Build the card**

`brief-card.tsx` — a client component, since it holds the accept/dismiss interaction. Shows: title, content-type badge, suggested channel, score, angle, why-now, key points as a list, and cited signals as links (`signal.url` may be null — render the title without a link then).

Accept calls `acceptBrief(id)` and on `{ ok: true }` navigates to `/drafts/${contentPieceId}` with `useRouter().push`. That route is the draft editor and takes a **content piece id** despite its `[releaseId]` param name (see `src/app/(dashboard)/drafts/[releaseId]/page.tsx`, which queries `contentPieces`). On `{ ok: false }` show `result.error` — do not swallow it.

Dismiss opens a small form: a required reason from the five `briefDismissReasonEnum` members with human labels, and an optional note. Import the enum values from the schema rather than retyping the strings.

- [ ] **Step 4: Add the nav entry**

In `src/app/(dashboard)/nav-links.tsx`, add to the `NAV` array after Signals, with a lucide icon (`Inbox` fits and is not yet imported):

```typescript
  { href: "/briefs", label: "Briefs", icon: Inbox },
```

- [ ] **Step 5: Verify**

```bash
npm run typecheck
npx eslint "src/app/(dashboard)/briefs" src/app/\(dashboard\)/nav-links.tsx
npm run test
```

Expected: typecheck clean, no new lint errors, suite green.

**Browser verification is NOT possible here** — the dev preview sits behind a Google/GitHub OAuth wall, so the page cannot be loaded without credentials. Do not attempt it and do not report visual confirmation you did not obtain. `tsc` and `eslint` are the gates.

- [ ] **Step 6: Run the full suite twice**

The suite is flaky against one shared Postgres; a single green run is not evidence.

```bash
npm run test 2>&1 | tail -8
npm run test 2>&1 | tail -8
```

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/briefs" "src/app/(dashboard)/nav-links.tsx"
git commit -m "feat: the brief inbox"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `brief_runs` table, six columns | 1 |
| `contentPieceId` FK, `ON DELETE SET NULL` | 1 |
| Partial unique index NOT re-added (already exists) | 1 (stated in File Structure) |
| `recordRun` at both exits, error string captured | 2 |
| `console.error` retained alongside the row | 2 (step 4) |
| `listBriefs`, tenant-scoped, score+recency, cited signals | 3 |
| `latestBriefRun` | 3 |
| Accept: transaction, scaffold body, both-way link | 4 |
| Accept: cross-tenant refusal, already-decided no-op | 4 |
| Dismiss: five columns, same guards | 4 |
| `/briefs` page, header, three empty states, card, filters | 5 |
| Nav entry | 5 |

**Type consistency:** `BriefWithSignals`, `CitedSignal`, `BriefFilters` (Task 3) are consumed by Task 5 under the same names. `AcceptResult`, `DismissResult`, `DismissReason`, `scaffoldBody` (Task 4) likewise. `recordRun` is module-private and named identically in both call sites.

**Known gaps carried forward, not fixed here:**

- `sweepIdeation` still discards `IdeationRunResult`. The run row now captures the outcome, so nothing is lost, but the sweep remains unable to report per-tenant failures to its caller.
- Editing a brief before accepting (`briefs.editedAt`) stays unused.
- No retention on `brief_runs`; `ranAt` is stored so a purge is a later change.
- The accept race guard (`status = "new"` inside the UPDATE) is likely not exercised by the suite — Task 4 step 5 asks the implementer to confirm and report this rather than leave it assumed.
