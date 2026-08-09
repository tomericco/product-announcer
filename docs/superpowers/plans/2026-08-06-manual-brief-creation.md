# Manual Brief Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human point the brief agent at signals they already know matter, and enter a signal the agents never found.

**Architecture:** A new `proposeBriefFromSignals` call inverts `ideate`'s instruction — the human has decided, so produce the brief rather than judging whether one is warranted — and returns exactly one proposal, with the caller's signal selection kept authoritative. A failed proposal degrades to a blank form. Manual signals are ordinary `signals` rows with `kind: "manual"`. Manual briefs never expire, via a nullable `expiresAt`.

**Tech Stack:** Next.js 16 App Router, AI SDK v7 + `@ai-sdk/anthropic`, Drizzle ORM 0.45.2, Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-manual-brief-creation-design.md`

## Global Constraints

- **This is NOT the Next.js you know.** Read the relevant guide in `node_modules/next/dist/docs/` before writing App Router code. `searchParams` is a Promise and must be awaited.
- **`npm run build` is a mandatory gate, ahead of the test suite.** It has caught a `"use server"` export-rule break that the whole suite missed, twice in this project.
- **NO TEST MAY REACH THE REAL ANTHROPIC API.** Every model call is injected in tests. A test that would issue a request is a defect regardless of whether it passes.
- **The tests are the contract. If prose and a code sample in this plan disagree, STOP and report it.** Implementers on the previous three plans did this seven times and were right every time — the plan was wrong, not them.
- **A comment that promises behaviour the code does not implement is a bug.**
- **When you add a test to guard a behaviour, delete the guard and confirm the test fails.**
- **Every query and mutation must be tenant-scoped.** Briefs and signals carry the company's unpublished strategy; an id arriving from a form is user-supplied.
- After any schema change run BOTH `npm run db:migrate:test` and `npm run db:migrate`.
- `briefs` requires `lastEvidenceAt` (NOT NULL, no default). `expiresAt` becomes nullable in Task 1.
- The suite is FLAKY (~162 files, one shared Postgres). If a file you did not touch fails, do NOT conclude "pre-existing" from a stash test alone — that mistake let a real regression through earlier in this project.
- The UI cannot be visually verified; the dev preview is behind an OAuth wall. Do not attempt it and do not report visual confirmation you did not obtain.
- Commit after each task. Do NOT push. Do NOT merge.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/db/schema.ts` | `briefs.expiresAt` nullable | 1 |
| `src/lib/briefs/sweep.ts` | explicit `isNotNull` predicate | 1 |
| `src/lib/briefs/ideate.ts` | export `ProposedBriefSchema` | 2 |
| `src/lib/briefs/propose.ts` | `proposeBriefFromSignals` | 2 |
| `src/lib/signals/manual.ts` | `createManualSignal` | 3 |
| `src/app/(dashboard)/signals/*` | selection, create-brief bar, add-signal form | 4 |
| `src/app/(dashboard)/briefs/new/*` | the brief form and its save action | 5 |

---

### Task 1: A brief that never expires

**Files:**
- Modify: `src/db/schema.ts` (the `briefs` table), `src/lib/briefs/sweep.ts`
- Create: `src/db/migrations/<generated>.sql`
- Test: `tests/lib/briefs/sweep.test.ts` (existing — add to it)

**Interfaces:**
- Produces: `briefs.expiresAt` is `timestamptz | null`; NULL means no expiry.

**Why:** `expireStaleBriefs` ages `new` briefs out at `BRIEF_TTL_DAYS` (14) because the agent generates continuously. A hand-written brief is a deliberate act and must not be deleted on a timer. Giving it a far-future date would be a value the data claims and the system never honours; NULL says what is true.

- [ ] **Step 1: Write the failing test**

Add to `tests/lib/briefs/sweep.test.ts`, reusing that file's existing seed helpers:

```typescript
  it("never expires a brief with no expiry date", async () => {
    const tenant = await seedTenant();
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const agentBrief = await seedBrief(tenant.id, { origin: "agent", expiresAt: past });
    const manualBrief = await seedBrief(tenant.id, { origin: "manual", expiresAt: null });

    const expired = await expireStaleBriefs({ database: db });
    expect(expired).toBe(1);

    const [agent] = await db.select().from(briefs).where(eq(briefs.id, agentBrief.id));
    const [manual] = await db.select().from(briefs).where(eq(briefs.id, manualBrief.id));
    expect(agent.status).toBe("expired");
    // A brief someone wrote by hand is a decision, not a proposal awaiting one.
    expect(manual.status).toBe("new");
  });
```

Read the top of the existing file first and match its `seedBrief` helper's parameters — do not invent a parallel one. If that helper does not accept `origin` or `expiresAt` overrides, widen it rather than duplicating it.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/lib/briefs/sweep.test.ts -t "never expires"
```

Expected: FAIL — `expiresAt` is NOT NULL, so the insert is rejected.

- [ ] **Step 3: Make the column nullable**

In `src/db/schema.ts`, in the `briefs` table:

```typescript
    // Null means this brief never expires. Agent briefs always carry a date —
    // the inbox would otherwise accumulate undecided proposals forever — but a
    // brief a human wrote by hand is a deliberate act, and deleting it on a
    // timer is not ours to do. A far-future date was the alternative and would
    // have been a value the data claims and the sweep never honours.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
```

- [ ] **Step 4: Make the sweep's exclusion explicit**

In `src/lib/briefs/sweep.ts`, add `isNotNull` to the drizzle import and to the predicate:

```typescript
  const rows = await database
    .update(briefs)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        eq(briefs.status, "new"),
        // Stated rather than implied. SQL's three-valued logic already excludes
        // NULL from the comparison below, but a later rewrite of this query
        // would not obviously preserve that, and the failure would be silent
        // deletion of hand-written briefs.
        isNotNull(briefs.expiresAt),
        lte(briefs.expiresAt, new Date())
      )
    )
    .returning({ id: briefs.id });
```

- [ ] **Step 5: Generate and apply the migration**

```bash
npm run db:generate
npm run db:migrate:test && npm run db:migrate
```

This is a widening change — every existing row has a value — so no backfill is needed. Confirm the generated SQL is a `DROP NOT NULL` and nothing else.

- [ ] **Step 6: Verify**

```bash
npx vitest run tests/lib/briefs/sweep.test.ts
npm run typecheck
npm run build
```

- [ ] **Step 7: Prove the guard bites**

Remove `isNotNull(briefs.expiresAt)` from the predicate. The new test must still pass (three-valued logic covers it), which is the point — so ALSO temporarily change the manual fixture's `expiresAt` to a past date and confirm the test then fails. That proves the test is watching the right column. Restore both.

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/db/migrations src/lib/briefs/sweep.ts tests/lib/briefs/sweep.test.ts
git commit -m "feat: let a brief have no expiry, and never expire one"
```

---

### Task 2: Propose a brief from chosen signals

**Files:**
- Modify: `src/lib/briefs/ideate.ts` (export `ProposedBriefSchema`)
- Create: `src/lib/briefs/propose.ts`
- Test: `tests/lib/briefs/propose.test.ts`

**Interfaces:**
- Produces:
```typescript
export const MAX_PROPOSAL_SIGNALS = 10;
export const MAX_PROPOSAL_OUTPUT_TOKENS = 2_000;
export type ProposalInput = { id: string; kind: string; title: string; excerpt: string | null; occurredAt: Date | null };
export type ProposalResult =
  | { ok: true; brief: Omit<ProposedBrief, "evidenceSignalIds"> }
  | { ok: false; error: string };
export async function proposeBriefFromSignals(
  args: { signals: ProposalInput[]; profile: RelevanceProfile; tenantId: string },
  deps?: { generate?: ProposalGenerate }
): Promise<ProposalResult>;
```

**The decision this task exists to encode.** `ideate`'s prompt asks the model to *"decide what — if anything — this company should publish"* and imposes *"THE BAR. Propose a brief only if you would defend it in an editorial meeting to a skeptical head of marketing."* It has twice refused to propose anything — correctly, but that is exactly what this feature routes around. **Do not reuse `ideate` and do not copy that language.** The new prompt states that the human has already selected these signals and decided something should be written, and asks only for the brief.

**`evidenceSignalIds` is omitted from the schema entirely** — `ProposedBriefSchema.omit({ evidenceSignalIds: true })` — so the model cannot drop, add to, or reorder the human's selection. The caller supplies it.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn(async () => {}) }));

import { proposeBriefFromSignals, MAX_PROPOSAL_SIGNALS } from "../../../src/lib/briefs/propose";
import { recordLlmUsage } from "../../../src/lib/ai/llm-usage";

const PROFILE = { name: "Frontitude", oneLiner: "UX content platform", positioning: null, topics: ["ux writing"] };
const SIGNALS = [
  { id: "s1", kind: "market_news", title: "API-driven localization", excerpt: "Runtime translation.", occurredAt: new Date("2026-07-17") },
  { id: "s2", kind: "competitor_move", title: "Rival ships glossary", excerpt: null, occurredAt: null },
];
const GOOD = {
  contentType: "blog_post", title: "T", angle: "A", whyNow: "W", audience: null,
  keyPoints: ["One.", "Two.", "Three."], targetLength: 700, suggestedChannel: "blog",
  score: 0.7, scoreRationale: "R",
};

describe("proposeBriefFromSignals", () => {
  it("returns one brief and never carries evidence ids from the model", async () => {
    const generate = vi.fn(async () => ({ object: { ...GOOD, evidenceSignalIds: ["HALLUCINATED"] }, usage: {} }));
    const result = await proposeBriefFromSignals(
      { signals: SIGNALS, profile: PROFILE, tenantId: "t1" },
      { generate: generate as never }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The human chose the signals. The model does not get a vote, so the field
    // is not even in its schema — this asserts it cannot leak through.
    expect(result.brief).not.toHaveProperty("evidenceSignalIds");
    expect(result.brief.title).toBe("T");
  });

  it("does NOT ask the model whether anything is worth publishing", async () => {
    const generate = vi.fn(async () => ({ object: GOOD, usage: {} }));
    await proposeBriefFromSignals(
      { signals: SIGNALS, profile: PROFILE, tenantId: "t1" },
      { generate: generate as never }
    );
    const call = generate.mock.calls[0][0] as { system: string; prompt: string };
    const text = `${call.system}\n${call.prompt}`;

    // The regression that would silently restore ideate's refusal behaviour —
    // and it has refused twice on real data. Nothing else would catch it.
    expect(text).not.toMatch(/if anything/i);
    expect(text).not.toMatch(/skeptical head of marketing/i);
    expect(text).not.toMatch(/\bTHE BAR\b/);
    // And it must say the opposite.
    expect(text).toMatch(/already (chosen|selected|decided)/i);
  });

  it("passes the chosen signals to the model", async () => {
    const generate = vi.fn(async () => ({ object: GOOD, usage: {} }));
    await proposeBriefFromSignals(
      { signals: SIGNALS, profile: PROFILE, tenantId: "t1" },
      { generate: generate as never }
    );
    const { prompt } = generate.mock.calls[0][0] as { prompt: string };
    expect(prompt).toContain("API-driven localization");
    expect(prompt).toContain("Rival ships glossary");
  });

  it("caps how many signals reach the prompt", async () => {
    const many = Array.from({ length: MAX_PROPOSAL_SIGNALS + 5 }, (_, i) => ({
      id: `s${i}`, kind: "manual", title: `Signal ${i}`, excerpt: null, occurredAt: null,
    }));
    const generate = vi.fn(async () => ({ object: GOOD, usage: {} }));
    await proposeBriefFromSignals(
      { signals: many, profile: PROFILE, tenantId: "t1" },
      { generate: generate as never }
    );
    const { prompt } = generate.mock.calls[0][0] as { prompt: string };
    expect(prompt).toContain(`Signal ${MAX_PROPOSAL_SIGNALS - 1}`);
    expect(prompt).not.toContain(`Signal ${MAX_PROPOSAL_SIGNALS}`);
  });

  it("returns an error the form can render rather than throwing", async () => {
    const generate = vi.fn(async () => {
      throw new Error("model timeout");
    });
    const result = await proposeBriefFromSignals(
      { signals: SIGNALS, profile: PROFILE, tenantId: "t1" },
      { generate: generate as never }
    );
    // This path exists for when the agent is NOT helping. It must degrade to a
    // blank form, never block the human from writing the brief themselves.
    expect(result).toEqual({ ok: false, error: expect.stringContaining("model timeout") });
  });

  it("refuses an empty selection without calling the model", async () => {
    const generate = vi.fn();
    const result = await proposeBriefFromSignals(
      { signals: [], profile: PROFILE, tenantId: "t1" },
      { generate: generate as never }
    );
    expect(result.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  it("records usage under its own operation", async () => {
    const generate = vi.fn(async () => ({ object: GOOD, usage: { inputTokens: 1, outputTokens: 2 } }));
    await proposeBriefFromSignals(
      { signals: SIGNALS, profile: PROFILE, tenantId: "t1" },
      { generate: generate as never }
    );
    expect(vi.mocked(recordLlmUsage).mock.calls.at(-1)?.[0]).toMatchObject({
      tenantId: "t1",
      operation: "brief_proposal",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/lib/briefs/propose.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Export the shared schema**

In `src/lib/briefs/ideate.ts`, change `const ProposedBriefSchema` to `export const ProposedBriefSchema`. Change nothing else in that file — its prompt, its bar, and its behaviour stay exactly as they are.

- [ ] **Step 4: Add the operation to the closed union**

`LlmOperation` in `src/lib/ai/llm-usage.ts` is a **closed** string-literal union while the database column is free text, so an omission fails at `tsc` and a wrong value fails nowhere — it just mis-attributes cost forever. Add `| "brief_proposal"`.

- [ ] **Step 5: Write the module**

`src/lib/briefs/propose.ts`. Its system prompt reuses `ideate`'s company framing (name, one-liner, positioning, topics) and then diverges:

```
A person on the content team has ALREADY chosen the signals below and already
decided this company should publish something about them. That editorial
judgement is made — it is not yours to revisit.

Write the brief that commissions the piece. Do not assess whether the material
merits publishing, do not propose alternatives, and do not decline.
```

Then the same craft rules `ideate` uses for a proposal: 3–5 key points of one sentence each, a concrete angle, a why-now grounded in the signals given.

The schema is `ProposedBriefSchema.omit({ evidenceSignalIds: true })`. Signals are truncated to `MAX_PROPOSAL_SIGNALS` before serialising. The whole body is wrapped so any throw returns `{ ok: false, error }`. `maxOutputTokens` is `MAX_PROPOSAL_OUTPUT_TOKENS` — one brief needs far less than `ideate`'s 8,000.

- [ ] **Step 6: Verify**

```bash
npx vitest run tests/lib/briefs/propose.test.ts
npm run typecheck
npm run build
```

- [ ] **Step 7: Prove two guards bite**

1. Add the sentence `Propose a brief only if you would defend it to a skeptical head of marketing.` to the system prompt. The "does NOT ask the model whether anything is worth publishing" test must FAIL.
2. Use the full `ProposedBriefSchema` instead of the omitted one and spread the model's object straight through. The "never carries evidence ids from the model" test must FAIL.

Restore both and re-run.

- [ ] **Step 8: Commit**

```bash
git add src/lib/briefs/propose.ts src/lib/briefs/ideate.ts src/lib/ai/llm-usage.ts tests/lib/briefs/propose.test.ts
git commit -m "feat: propose a brief from signals a human already chose"
```

---

### Task 3: Manual signals

**Files:**
- Create: `src/lib/signals/manual.ts`
- Test: `tests/lib/signals/manual.test.ts`

**Interfaces:**
- Produces:
```typescript
export type ManualSignalInput = { title: string; url?: string | null; excerpt?: string | null; occurredAt?: Date | null };
export type ManualSignalResult = { ok: true; id: string } | { ok: false; error: string };
export async function createManualSignal(
  tenantId: string,
  input: ManualSignalInput,
  database?: typeof defaultDb
): Promise<ManualSignalResult>;
```

**`externalId` derivation.** The column is NOT NULL and participates in `signals_tenant_kind_external_unique`. With a URL, use `normalizeArticleUrl` from `src/lib/signals/news-agent.ts` — its own doc frames it as `signals.externalId`'s identity function, not a news-only helper, so entering the same link twice is caught as a duplicate. Without one, generate a UUID, so two signals that merely share a title do not collide.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, signals } from "../../../src/db/schema";
import { createManualSignal } from "../../../src/lib/signals/manual";

const TENANT = "Manual Signal Test Tenant";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  return tenant;
}

describe("createManualSignal", () => {
  it("writes a manual signal keyed on the normalised url", async () => {
    const tenant = await seedTenant();
    const result = await createManualSignal(
      tenant.id,
      { title: "A webinar", url: "https://Example.com/talk/?utm_source=x", excerpt: "Notes." },
      db
    );
    expect(result.ok).toBe(true);

    const [row] = await db.select().from(signals).where(eq(signals.tenantId, tenant.id));
    expect(row.kind).toBe("manual");
    expect(row.title).toBe("A webinar");
    // Same normalisation as every other signal, so the same link entered twice
    // is one signal rather than two.
    expect(row.externalId).toBe("https://example.com/talk");
    expect(row.occurredAt).toBeInstanceOf(Date);
  });

  it("generates an id when there is no url, so two untitled-source signals never collide", async () => {
    const tenant = await seedTenant();
    await createManualSignal(tenant.id, { title: "A conference talk" }, db);
    const second = await createManualSignal(tenant.id, { title: "A conference talk" }, db);
    expect(second.ok).toBe(true);

    const rows = await db.select().from(signals).where(eq(signals.tenantId, tenant.id));
    expect(rows).toHaveLength(2);
    expect(rows[0].externalId).not.toBe(rows[1].externalId);
  });

  it("reports a duplicate url instead of writing a second row", async () => {
    const tenant = await seedTenant();
    await createManualSignal(tenant.id, { title: "First", url: "https://example.com/a" }, db);
    const second = await createManualSignal(tenant.id, { title: "Second", url: "https://example.com/a/" }, db);

    expect(second.ok).toBe(false);
    const rows = await db.select().from(signals).where(eq(signals.tenantId, tenant.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("First");
  });

  it("refuses a blank title", async () => {
    const tenant = await seedTenant();
    const result = await createManualSignal(tenant.id, { title: "   " }, db);
    expect(result.ok).toBe(false);
    expect(await db.select().from(signals).where(eq(signals.tenantId, tenant.id))).toHaveLength(0);
  });

  it("scopes the signal to the calling tenant", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    await createManualSignal(mine.id, { title: "Mine" }, db);

    const theirs = await db
      .select()
      .from(signals)
      .where(and(eq(signals.tenantId, other.id), eq(signals.kind, "manual")));
    expect(theirs).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/lib/signals/manual.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

It must: trim and reject a blank title; derive `externalId` as described; default `occurredAt` to now; write `kind: "manual"`; and catch a unique-constraint violation (Postgres `23505`) to return a duplicate error rather than throwing. `status` and `topics` take their schema defaults; `relevanceScore` stays null — a human-entered signal was not scored, and null means "not scored", not "scored zero".

- [ ] **Step 4: Verify**

```bash
npx vitest run tests/lib/signals/manual.test.ts
npm run typecheck
npm run build
```

- [ ] **Step 5: Prove two guards bite**

1. Replace `normalizeArticleUrl(url)` with the raw `url`. The "keyed on the normalised url" and "reports a duplicate url" tests must FAIL.
2. Remove the blank-title check. That test must FAIL.

Restore both and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/lib/signals/manual.ts tests/lib/signals/manual.test.ts
git commit -m "feat: create a signal by hand"
```

---

### Task 4: Selection and the add-signal form

**Files:**
- Modify: `src/app/(dashboard)/signals/signals-list.tsx`, `signal-row.tsx`, `page.tsx`
- Create: `src/app/(dashboard)/signals/actions.ts`, and a client component for the add-signal form

**Interfaces:**
- Consumes: `createManualSignal` (Task 3).
- Produces: a server action `addSignal(input)` returning `{ ok: true; id } | { ok: false; error }`; selection state posted to `/briefs/new` as `?signals=<comma-separated ids>`.

**Read first:** `signals-list.tsx` currently takes `{ rows, competitorsById }` and groups rows by month; `signal-row.tsx` renders one row. Both carry comments saying selection is spec 6 and deliberately absent — this is that.

- [ ] **Step 1: Add selection**

`SignalsList` becomes a client component holding a `Set<string>` of selected ids. Each row gets a checkbox. A bar appears when the selection is non-empty, showing the count and a **Create brief** link to `/briefs/new?signals=<ids>`.

Two rules the UI must enforce, both with a visible reason rather than a silently disabled control:
- **Cap at 10.** Beyond that the proposal prompt stops being bounded — the same reason `MAX_IDEATION_SIGNALS` exists. Import `MAX_PROPOSAL_SIGNALS` from `src/lib/briefs/propose.ts` rather than retyping `10`.
- **Stale signals are not selectable.** A stale `shipped_work` signal is work that was withdrawn; commissioning a brief about something that no longer ships is the failure `listSignals` filters for elsewhere. `row.status === "stale"` already drives a distinct style in `signal-row.tsx`.

- [ ] **Step 2: Add the signal form**

A dialog or inline form on `/signals` with: title (required), URL (optional), excerpt (optional), date (optional, defaults to today). It calls `addSignal`, which is `"use server"`, calls `requireSession`, delegates to `createManualSignal` with the session's tenant, and revalidates `/signals`.

**`src/app/(dashboard)/signals/actions.ts` will carry `"use server"` and may therefore export ONLY async functions.** A synchronous export there breaks the production build while every test passes — that has happened twice in this project.

On `{ ok: false }` show the error. The duplicate-URL case is the one users will hit; it must read as "you already have this signal", not as a crash.

- [ ] **Step 3: Verify**

```bash
npm run build
npm run typecheck
npx eslint "src/app/(dashboard)/signals"
npm run test
```

Browser verification is not possible — the dev preview is behind an OAuth wall. State that plainly in your report.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/signals"
git commit -m "feat: select signals, and add one by hand"
```

---

### Task 5: The brief form

**Files:**
- Create: `src/app/(dashboard)/briefs/new/page.tsx`, a client form component, and `src/app/(dashboard)/briefs/new/actions.ts`
- Test: `tests/app/briefs-new-actions.test.ts`

**Interfaces:**
- Consumes: `proposeBriefFromSignals` (Task 2); `listSignals` from `src/lib/signals/query.ts`.
- Produces: `createManualBrief(input)` returning `{ ok: true; briefId } | { ok: false; error }`.

- [ ] **Step 1: Build the page**

`/briefs/new` is an async Server Component. `searchParams` is a **Promise and must be awaited** — copy the pattern from `src/app/(dashboard)/signals/page.tsx`, which documents it.

It reads `?signals=<ids>`, loads those signals **scoped to the session's tenant** (ids come from a URL and are user-supplied), and calls `proposeBriefFromSignals`. It then renders the form pre-filled from the proposal.

**On `{ ok: false }` it renders the form EMPTY with the error shown.** This is the whole point of the degradation rule: the path exists for when the agent is not helping, so it must not require the agent to work. A page that errors out here is a defect.

- [ ] **Step 2: Write the failing test for the save action**

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, briefs, briefSignals, signals } from "../../src/db/schema";

const TENANT = "New Brief Actions Test Tenant";
let currentTenantId = "";
let currentUserId: string | null = null;

vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createManualBrief } from "../../src/app/(dashboard)/briefs/new/actions";

afterEach(async () => {
  await db.delete(tenants).where(eq(tenants.name, TENANT));
  vi.clearAllMocks();
});

async function seedTenant() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  currentTenantId = tenant.id;
  return tenant;
}

async function seedSignal(tenantId: string, title = "Evidence") {
  const [row] = await db
    .insert(signals)
    .values({ tenantId, kind: "manual", externalId: crypto.randomUUID(), title, occurredAt: new Date() })
    .returning();
  return row;
}

const FORM = {
  contentType: "blog_post" as const,
  title: "A title",
  angle: "An angle",
  whyNow: "Because",
  keyPoints: ["One.", "Two.", "Three."],
  suggestedChannel: "blog",
  targetLength: 700,
  audience: null,
  score: 0.7,
};

describe("createManualBrief", () => {
  it("saves a manual brief that never expires, with its evidence attached", async () => {
    const tenant = await seedTenant();
    currentUserId = null;
    const signal = await seedSignal(tenant.id);

    const result = await createManualBrief({ ...FORM, signalIds: [signal.id] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [brief] = await db.select().from(briefs).where(eq(briefs.id, result.briefId));
    expect(brief.origin).toBe("manual");
    expect(brief.status).toBe("new");
    // A hand-written brief is a decision, not a proposal awaiting one.
    expect(brief.expiresAt).toBeNull();
    expect(brief.lastEvidenceAt).toBeInstanceOf(Date);

    const links = await db.select().from(briefSignals).where(eq(briefSignals.briefId, brief.id));
    expect(links.map((l) => l.signalId)).toEqual([signal.id]);
  });

  it("refuses a signal belonging to another tenant and writes nothing", async () => {
    const mine = await seedTenant();
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    const theirs = await seedSignal(other.id, "Theirs");

    // The ids come from a form field and are user-supplied. Attaching another
    // tenant's signal would leak its title into this tenant's brief and into
    // every draft generated from it.
    const result = await createManualBrief({ ...FORM, signalIds: [theirs.id] });
    expect(result.ok).toBe(false);
    expect(await db.select().from(briefs).where(eq(briefs.tenantId, mine.id))).toHaveLength(0);
  });

  it("refuses a blank title", async () => {
    const tenant = await seedTenant();
    const signal = await seedSignal(tenant.id);
    const result = await createManualBrief({ ...FORM, title: "  ", signalIds: [signal.id] });
    expect(result.ok).toBe(false);
    expect(await db.select().from(briefs).where(eq(briefs.tenantId, tenant.id))).toHaveLength(0);
  });

  it("saves a brief with no signals at all", async () => {
    await seedTenant();
    // The degradation path: the proposal failed, the human wrote it themselves,
    // and they may not have selected anything. That must still save.
    const result = await createManualBrief({ ...FORM, signalIds: [] });
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run tests/app/briefs-new-actions.test.ts
```

Expected: FAIL — the actions module does not exist.

- [ ] **Step 4: Write the action**

`"use server"`, so **only async exports**. It must: `requireSession`; trim and reject a blank title; re-read the given signal ids **scoped to the session's tenant** and reject if any is missing; insert the brief with `origin: "manual"`, `status: "new"`, `createdBy: session.user.id ?? null`, `expiresAt: null`, `lastEvidenceAt: new Date()`; insert the `brief_signals` rows; revalidate `/briefs`; and return the new id so the client can navigate to the inbox.

- [ ] **Step 5: Verify**

```bash
npx vitest run tests/app/briefs-new-actions.test.ts
npm run typecheck
npm run build
npx eslint "src/app/(dashboard)/briefs"
npm run test
npm run test
```

- [ ] **Step 6: Prove two guards bite**

1. Remove the tenant predicate from the signal re-read. "refuses a signal belonging to another tenant" must FAIL.
2. Change `expiresAt: null` to a date. "saves a manual brief that never expires" must FAIL.

Restore both and re-run.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/briefs/new" tests/app/briefs-new-actions.test.ts
git commit -m "feat: create a brief from chosen signals"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `expiresAt` nullable, NULL = no expiry | 1 |
| Explicit `isNotNull` on the sweep | 1 |
| `proposeBriefFromSignals` is a new call, not `ideate` | 2 |
| Prompt does not carry `ideate`'s bar language | 2 (test + guard proof) |
| `evidenceSignalIds` not taken from the model | 2 (omitted from the schema) |
| Reuses schema, framing, 3–5 cap, explicit maxOutputTokens | 2 |
| Failure degrades to a blank form | 2 (result type) + 5 (page renders it) |
| Manual signal, `kind: "manual"`, externalId derivation | 3 |
| Duplicate URL rejected, not duplicated | 3 |
| Selection UI, cap 10, stale excluded | 4 |
| Add-signal form | 4 |
| Brief form, `origin: "manual"`, `createdBy`, evidence joined | 5 |
| Tenant scoping everywhere | 3, 5 (both tested) |

**Type consistency:** `MAX_PROPOSAL_SIGNALS` is defined in Task 2 and imported by Task 4. `ProposalResult`'s `{ ok, error }` shape matches what Task 5's page renders. `createManualSignal`'s result shape matches what Task 4's action returns.

**Known gaps carried forward:**

- Auto-filling a manual signal from a pasted URL via `fetchPageText`.
- `score` on a manual brief is close to meaningless; the inbox still orders by it.
- This routes around the signal-quality problem rather than fixing it.
