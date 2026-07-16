# Curated Example Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Seed a global catalog of example product updates tagged by industry/persona/category, select the best-matching few at generation time (strict match, capped), and inject them into the generation prompt as few-shot exemplars.

**Architecture:** A new `system_update_examples` seeded table (mirrors `system_personas`). A pure `selectExamples` scorer picks matches; a `systemPersonaKeys` helper derives persona criteria from the brand profile. `runBatchForWorkspace` loads the catalog, selects, and passes examples into `generateUpdateDraft`, whose `buildSystemPrompt` renders an examples block.

**Tech Stack:** Next.js (App Router), Drizzle ORM + Postgres, `ai` v7 (`generateObject`), Zod, Vitest.

## Global Constraints

- **This is NOT stock Next.js** — per `AGENTS.md`; this plan touches no new Next.js APIs.
- **Seeded catalog only** — no tenant-authored examples, no settings UI in B.
- **Strict selection:** an example is a candidate only if its `industry` matches (case-insensitive) OR its `persona_key` is one of the tenant's system persona keys. Score = (industry match ? 1 : 0) + (persona match ? 1 : 0); drop score 0; sort by score desc then `sort_order` asc; cap at **limit = 3**. No match → empty (no examples block).
- **Category is never used for selection** — stored and used only as a prompt label `Example (<category>):`.
- **Industry strings** in the seed must exactly match canonical entries in `INDUSTRIES` (`src/app/(dashboard)/settings/industry-select.tsx`): `SaaS`, `Developer Tools`, `Fintech`, `E-commerce`, `Healthcare`.
- **Persona keys** in the seed must exactly match seeded `system_personas.key` values: `developer`, `product-manager`, `marketing-manager`, `support-lead` (from `0009_round_blade.sql`).
- **Reuse the existing `update_category` enum** (`new`/`improved`/`fixed`) for the example `category`.
- Test command: `npm test` (`vitest run`); `npm test -- <name>` filters. Migrations: `npm run db:generate` then `npm run db:migrate`.

---

### Task 1: `system_update_examples` table + seed migration

**Files:**
- Modify: `src/db/schema.ts` (add table after the `systemPersonas` block, before `export const updates`, ~line 153)
- Create: `src/db/migrations/0011_*.sql` (generated, then hand-append the seed INSERT)
- Test: `tests/lib/system-update-examples.test.ts`

**Interfaces:**
- Produces: `systemUpdateExamples` table and `type ExampleRow = typeof systemUpdateExamples.$inferSelect` — columns: `id`, `key` (unique), `industry` (nullable), `personaKey` (nullable, `persona_key`), `category` (`update_category`), `title`, `body`, `sortOrder` (`sort_order`), `createdAt`. Consumed by Tasks 3, 4, 5.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/system-update-examples.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { systemUpdateExamples } from "../../src/db/schema";

describe("system_update_examples seed", () => {
  it("seeds a matchable catalog of at least 12 examples", async () => {
    const all = await db.select().from(systemUpdateExamples);
    expect(all.length).toBeGreaterThanOrEqual(12);
    // every seeded row must be matchable: it has an industry or a persona_key
    expect(all.every((e) => e.industry !== null || e.personaKey !== null)).toBe(true);
  });

  it("includes the devtools/developer/new exemplar with the expected tags", async () => {
    const [row] = await db
      .select()
      .from(systemUpdateExamples)
      .where(eq(systemUpdateExamples.key, "devtools-developer-new"));
    expect(row).toBeDefined();
    expect(row.industry).toBe("Developer Tools");
    expect(row.personaKey).toBe("developer");
    expect(row.category).toBe("new");
    expect(row.title.length).toBeGreaterThan(0);
    expect(row.body.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- system-update-examples`
Expected: FAIL — `systemUpdateExamples` is not exported from schema (module/column error).

- [ ] **Step 3: Add the table to the schema**

In `src/db/schema.ts`, add immediately after the `systemPersonas` table block (before `export const updates = pgTable(...)`):

```ts
// Global, seeded catalog of example product updates. Selected at generation time
// by industry/persona match and injected into the prompt as few-shot exemplars.
export const systemUpdateExamples = pgTable("system_update_examples", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  key: text("key").notNull().unique(),
  industry: text("industry"),
  personaKey: text("persona_key"),
  category: updateCategoryEnum("category").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

(`pgTable`, `uuid`, `text`, `integer`, `timestamp`, and `updateCategoryEnum` are all already imported/declared above in this file.)

- [ ] **Step 4: Generate the migration**

Run: `npm run db:generate`
Expected: creates `src/db/migrations/0011_*.sql` containing the `CREATE TABLE "system_update_examples"` statement (no seed data yet).

- [ ] **Step 5: Append the seed INSERT to the generated migration**

Open the generated `0011_*.sql` and append, after the `CREATE TABLE` statement, the following (uses Postgres dollar-quoting `$$…$$` for `title`/`body` so apostrophes need no escaping):

```sql
--> statement-breakpoint
INSERT INTO "system_update_examples" ("id", "key", "industry", "persona_key", "category", "title", "body", "sort_order") VALUES
	(gen_random_uuid(), 'saas-pm-new', 'SaaS', 'product-manager', 'new', $$Dashboards you can share with your whole team$$, $$You can now create shared dashboards and invite teammates to view them in real time.

- Build a dashboard once and share it with a link
- Control who can view or edit
- See changes update live as data comes in

Great for keeping stakeholders aligned without exporting screenshots.$$, 10),
	(gen_random_uuid(), 'saas-marketing-improved', 'SaaS', 'marketing-manager', 'improved', $$Faster, cleaner reports that are ready to present$$, $$We rebuilt reporting from the ground up. Reports now load in under a second and export to a polished PDF in one click.

Whether you're sharing results with a client or your leadership team, your numbers look sharp and load instantly.$$, 20),
	(gen_random_uuid(), 'saas-support-fixed', 'SaaS', 'support-lead', 'fixed', $$Fixed: invitation emails landing in spam$$, $$Some invitation emails were being flagged as spam and never reached new users. We've updated our sending setup so invitations now arrive reliably in the inbox.

If a teammate reported a missing invite, ask them to resend it — it should arrive within a minute.$$, 30),
	(gen_random_uuid(), 'devtools-developer-new', 'Developer Tools', 'developer', 'new', $$Ship webhooks with the new Events API$$, $$The new Events API lets you subscribe to changes and receive signed webhook deliveries.

- `POST /v1/webhooks` to register an endpoint
- Verify payloads with the `X-Signature` header and your signing secret
- Automatic retries with exponential backoff for failed deliveries

See the Events reference for the full list of event types.$$, 40),
	(gen_random_uuid(), 'devtools-developer-improved', 'Developer Tools', 'developer', 'improved', $$Pagination is now cursor-based across every list endpoint$$, $$List endpoints now return a stable `next_cursor` instead of offset paging, so results no longer shift when records are added mid-scan.

- Pass `?cursor=<next_cursor>` to fetch the next page
- Offset params still work but are deprecated and will be removed in v2

Update your SDK to `>=3.2.0` to pick this up automatically.$$, 50),
	(gen_random_uuid(), 'devtools-developer-fixed', 'Developer Tools', 'developer', 'fixed', $$Fixed: rate-limit headers missing on 429 responses$$, $$`429 Too Many Requests` responses were omitting the `Retry-After` and `X-RateLimit-Reset` headers, making backoff hard to implement. Both headers are now returned on every throttled response.

No action needed — your existing retry logic will start seeing accurate reset times immediately.$$, 60),
	(gen_random_uuid(), 'fintech-pm-new', 'Fintech', 'product-manager', 'new', $$Set spending limits per card$$, $$Admins can now set daily and monthly spending limits on individual cards.

- Configure limits from the card's settings
- Limits apply instantly, no reissue needed
- Get notified when a card approaches its limit

A frequently requested control for teams managing employee spend.$$, 70),
	(gen_random_uuid(), 'fintech-support-fixed', 'Fintech', 'support-lead', 'fixed', $$Fixed: pending transactions showing the wrong balance$$, $$Pending transactions were briefly double-counted, causing available balances to look lower than they actually were. Balances now reflect pending activity correctly.

No customer action is needed — affected balances corrected themselves automatically. This did not affect any actual charges.$$, 80),
	(gen_random_uuid(), 'fintech-marketing-improved', 'Fintech', 'marketing-manager', 'improved', $$Instant transfers, now free on every plan$$, $$Instant transfers used to carry a small fee — now they're free for everyone, on every plan.

Move money between accounts in seconds, at no extra cost. It's a simpler, more competitive experience for your customers.$$, 90),
	(gen_random_uuid(), 'ecommerce-marketing-new', 'E-commerce', 'marketing-manager', 'new', $$Launch storewide sales with scheduled discounts$$, $$Plan your next promotion in advance with scheduled discounts.

- Set a start and end time — discounts go live and expire automatically
- Apply to your whole store, a collection, or specific products
- Preview the sale banner before it launches

Perfect for Black Friday, flash sales, and seasonal campaigns.$$, 100),
	(gen_random_uuid(), 'ecommerce-pm-improved', 'E-commerce', 'product-manager', 'improved', $$A faster, one-page checkout$$, $$We collapsed checkout into a single page, cutting the steps from four to one.

Early testing shows a meaningful lift in completed purchases, especially on mobile. Returning customers see their saved details prefilled for an even quicker checkout.$$, 110),
	(gen_random_uuid(), 'ecommerce-support-fixed', 'E-commerce', 'support-lead', 'fixed', $$Fixed: order confirmation emails delayed by several hours$$, $$Order confirmation emails were sometimes delayed by up to a few hours, prompting customers to ask whether their order went through. Confirmations now send within seconds of purchase.

If a customer contacts you about a missing confirmation, they can resend it from their order history page.$$, 120),
	(gen_random_uuid(), 'healthcare-pm-new', 'Healthcare', 'product-manager', 'new', $$Book appointments online, 24/7$$, $$Patients can now book, reschedule, and cancel appointments online at any time.

- See real-time availability by provider
- Automatic reminders reduce no-shows
- Syncs directly with your existing calendar

Less phone tag for your front desk, more convenience for patients.$$, 130),
	(gen_random_uuid(), 'healthcare-support-improved', 'Healthcare', 'support-lead', 'improved', $$Clearer messages when a document fails to upload$$, $$When a patient document failed to upload, the old error was vague and generated support tickets. Uploads now explain exactly what went wrong — file too large, unsupported format, or a connection issue — and how to fix it.

Expect fewer "my upload isn't working" questions.$$, 140)
ON CONFLICT ("key") DO NOTHING;
```

- [ ] **Step 6: Apply the migration**

Run: `npm run db:migrate`
Expected: table created and 14 example rows inserted.

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test -- system-update-examples`
Expected: PASS (both tests).

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: all existing tests still PASS (new table is additive).

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.ts src/db/migrations tests/lib/system-update-examples.test.ts
git commit -m "feat: add seeded system_update_examples catalog"
```

---

### Task 2: `systemPersonaKeys` helper

**Files:**
- Modify: `src/lib/personas.ts`
- Test: `tests/lib/personas.test.ts` (add cases)

**Interfaces:**
- Consumes: `PersonaRef` type (already in schema).
- Produces: `systemPersonaKeys(refs: PersonaRef[]): string[]` — the `key` of each `type: "system"` ref, in order; custom refs ignored.

- [ ] **Step 1: Write the failing test**

Add to `tests/lib/personas.test.ts` (new `describe` block; keep existing tests untouched):

```ts
import { systemPersonaKeys } from "../../src/lib/personas";

describe("systemPersonaKeys", () => {
  it("returns keys of system refs and ignores custom refs", () => {
    const keys = systemPersonaKeys([
      { type: "system", key: "developer" },
      { type: "custom", name: "Ops", brief: "runs infra" },
      { type: "system", key: "product-manager" },
    ]);
    expect(keys).toEqual(["developer", "product-manager"]);
  });

  it("returns an empty array for no refs or only custom refs", () => {
    expect(systemPersonaKeys([])).toEqual([]);
    expect(systemPersonaKeys([{ type: "custom", name: "Ops", brief: "x" }])).toEqual([]);
  });
});
```

Note: if `tests/lib/personas.test.ts` does not already import from `../../src/lib/personas`, add `systemPersonaKeys` to its existing import instead of duplicating the import line.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- personas`
Expected: FAIL — `systemPersonaKeys is not a function`.

- [ ] **Step 3: Implement the helper**

Append to `src/lib/personas.ts`:

```ts
/**
 * The `key` of each system persona ref on a brand profile, in order. Custom
 * personas have no key and are ignored — only system personas participate in
 * example matching.
 */
export function systemPersonaKeys(refs: PersonaRef[]): string[] {
  return refs.filter((r): r is Extract<PersonaRef, { type: "system" }> => r.type === "system").map((r) => r.key);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- personas`
Expected: PASS (existing persona tests + the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/personas.ts tests/lib/personas.test.ts
git commit -m "feat: add systemPersonaKeys helper"
```

---

### Task 3: `selectExamples` selection module

**Files:**
- Create: `src/lib/select-examples.ts`
- Test: `tests/lib/select-examples.test.ts`

**Interfaces:**
- Consumes: `ExampleRow` (Task 1).
- Produces:
  - `type ExampleCriteria = { industry: string | null; personaKeys: string[] }`
  - `selectExamples(examples: ExampleRow[], criteria: ExampleCriteria, limit?: number): ExampleRow[]` (default `limit = 3`).

- [ ] **Step 1: Write the failing test**

Create `tests/lib/select-examples.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selectExamples } from "../../src/lib/select-examples";
import type { systemUpdateExamples } from "../../src/db/schema";

type ExampleRow = typeof systemUpdateExamples.$inferSelect;

function ex(overrides: Partial<ExampleRow>): ExampleRow {
  return {
    id: "id",
    key: "k",
    industry: null,
    personaKey: null,
    category: "new",
    title: "t",
    body: "b",
    sortOrder: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("selectExamples", () => {
  it("ranks a both-tag match above a single-tag match", () => {
    const both = ex({ key: "both", industry: "SaaS", personaKey: "developer" });
    const industryOnly = ex({ key: "ind", industry: "SaaS", personaKey: "product-manager" });
    const result = selectExamples([industryOnly, both], { industry: "SaaS", personaKeys: ["developer"] });
    expect(result.map((r) => r.key)).toEqual(["both", "ind"]);
  });

  it("includes industry-only and persona-only matches, matching industry case-insensitively", () => {
    const industryOnly = ex({ key: "ind", industry: "saas", personaKey: "support-lead" });
    const personaOnly = ex({ key: "per", industry: "Fintech", personaKey: "developer" });
    const result = selectExamples([industryOnly, personaOnly], { industry: "SaaS", personaKeys: ["developer"] });
    expect(result.map((r) => r.key).sort()).toEqual(["ind", "per"]);
  });

  it("returns empty when nothing matches", () => {
    const none = ex({ key: "n", industry: "Fintech", personaKey: "support-lead" });
    expect(selectExamples([none], { industry: "SaaS", personaKeys: ["developer"] })).toEqual([]);
  });

  it("caps the result at the limit", () => {
    const rows = [1, 2, 3, 4].map((n) => ex({ key: `k${n}`, industry: "SaaS", sortOrder: n }));
    const result = selectExamples(rows, { industry: "SaaS", personaKeys: [] }, 2);
    expect(result).toHaveLength(2);
  });

  it("breaks equal-score ties by sort_order ascending", () => {
    const later = ex({ key: "later", industry: "SaaS", sortOrder: 20 });
    const earlier = ex({ key: "earlier", industry: "SaaS", sortOrder: 10 });
    const result = selectExamples([later, earlier], { industry: "SaaS", personaKeys: [] });
    expect(result.map((r) => r.key)).toEqual(["earlier", "later"]);
  });

  it("treats a null criteria industry as no industry match", () => {
    const industryRow = ex({ key: "ind", industry: "SaaS" });
    expect(selectExamples([industryRow], { industry: null, personaKeys: [] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- select-examples`
Expected: FAIL — `Cannot find module '../../src/lib/select-examples'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/select-examples.ts`:

```ts
import type { systemUpdateExamples } from "../db/schema";

export type ExampleRow = typeof systemUpdateExamples.$inferSelect;

export type ExampleCriteria = { industry: string | null; personaKeys: string[] };

function score(example: ExampleRow, criteria: ExampleCriteria): number {
  const industryMatch =
    example.industry !== null &&
    criteria.industry !== null &&
    example.industry.toLowerCase() === criteria.industry.toLowerCase();
  const personaMatch = example.personaKey !== null && criteria.personaKeys.includes(example.personaKey);
  return (industryMatch ? 1 : 0) + (personaMatch ? 1 : 0);
}

/**
 * Strict, capped few-shot selection. An example is a candidate only if it matches
 * the tenant's industry OR one of their system persona keys. Candidates are ranked
 * by match strength (both tags > one tag), ties broken by sort_order ascending, and
 * the top `limit` are returned. No candidates → empty array.
 */
export function selectExamples(
  examples: ExampleRow[],
  criteria: ExampleCriteria,
  limit = 3
): ExampleRow[] {
  return examples
    .map((example) => ({ example, s: score(example, criteria) }))
    .filter((c) => c.s > 0)
    .sort((a, b) => b.s - a.s || a.example.sortOrder - b.example.sortOrder)
    .slice(0, limit)
    .map((c) => c.example);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- select-examples`
Expected: PASS (all six tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/select-examples.ts tests/lib/select-examples.test.ts
git commit -m "feat: add selectExamples few-shot selector"
```

---

### Task 4: Render examples into the generation prompt

**Files:**
- Modify: `src/lib/generation.ts`
- Test: `tests/lib/generation.test.ts` (extend)

**Interfaces:**
- Consumes: `ExampleRow` (Task 1).
- Produces: `generateUpdateDraft(items, brandProfile, reposById, personas?, examples?)` — new trailing `examples: ExampleRow[] = []` param. `buildSystemPrompt` appends an examples block when non-empty.

- [ ] **Step 1: Write the failing test**

In `tests/lib/generation.test.ts`, add a new test inside the existing `describe("generateUpdateDraft", ...)` block:

```ts
  it("injects an examples block into the system prompt when examples are provided", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "x", body: "y", category: "new" },
    } as never);

    const items = [prItem()] as never;
    const brandProfile = {
      tone: null, readingLevel: null, doList: [], dontList: [], examplePhrases: [], industry: null, userPersonas: [],
    } as never;
    const examples = [
      { id: "1", key: "devtools-developer-new", industry: "Developer Tools", personaKey: "developer", category: "improved", title: "Cursor pagination", body: "Use next_cursor.", sortOrder: 0, createdAt: new Date() },
    ] as never;

    await generateUpdateDraft(items, brandProfile, REPOS, [], examples);

    const system = vi.mocked(generateObject).mock.calls.at(-1)![0].system as string;
    expect(system).toContain("mirror their structure");
    expect(system).toContain("Example (improved):");
    expect(system).toContain("Cursor pagination");
    expect(system).toContain("Use next_cursor.");
  });

  it("omits the examples block when no examples are provided", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "x", body: "y", category: "new" },
    } as never);
    const brandProfile = {
      tone: null, readingLevel: null, doList: [], dontList: [], examplePhrases: [], industry: null, userPersonas: [],
    } as never;

    await generateUpdateDraft([prItem()] as never, brandProfile, REPOS, []);

    const system = vi.mocked(generateObject).mock.calls.at(-1)![0].system as string;
    expect(system).not.toContain("Example (");
    expect(system).not.toContain("mirror their structure");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- generation`
Expected: FAIL — the examples block is not produced (`system` does not contain "Example (improved):"); `generateUpdateDraft` ignores the 5th argument.

- [ ] **Step 3: Update `generation.ts`**

At the top of `src/lib/generation.ts`, extend the schema-type import to include the examples table type:

```ts
import type { changeItems, brandProfiles, ResolvedPersona, systemUpdateExamples } from "../db/schema";
```

Add this alias next to the other row-type aliases near the top of the file:

```ts
type ExampleRow = typeof systemUpdateExamples.$inferSelect;
```

Add an example renderer above `buildSystemPrompt`:

```ts
function renderExample(example: ExampleRow): string {
  return `Example (${example.category}):\nTitle: ${example.title}\nBody:\n${example.body}`;
}
```

Change `buildSystemPrompt` to take and render examples. Replace its signature and `return` with:

```ts
function buildSystemPrompt(
  brandProfile: BrandProfileRow,
  personas: ResolvedPersona[],
  examples: ExampleRow[]
): string {
  const lines = [
    "You write concise, user-facing product update announcements.",
    brandProfile.industry ? `Industry: ${brandProfile.industry}.` : null,
    personas.length > 0
      ? `Audience personas — tailor the update to appeal to each: ${personas
          .map((p) => `${p.name}: ${p.brief}`)
          .join(" ")}`
      : null,
    brandProfile.tone ? `Tone: ${brandProfile.tone}.` : null,
    brandProfile.readingLevel ? `Reading level: ${brandProfile.readingLevel}.` : null,
    brandProfile.doList.length > 0 ? `Do: ${brandProfile.doList.join("; ")}.` : null,
    brandProfile.dontList.length > 0 ? `Avoid: ${brandProfile.dontList.join("; ")}.` : null,
  ].filter((line): line is string => Boolean(line));

  const base = lines.join(" ");
  if (examples.length === 0) return base;

  const block = [
    "Here are example updates for a similar audience — mirror their structure, depth, and voice; do not reuse their wording or specifics:",
    ...examples.map(renderExample),
  ].join("\n\n");

  return `${base}\n\n${block}`;
}
```

Update `generateUpdateDraft` to accept and forward `examples`:

```ts
export async function generateUpdateDraft(
  items: ChangeItemRow[],
  brandProfile: BrandProfileRow,
  reposById: Map<string, string>,
  personas: ResolvedPersona[] = [],
  examples: ExampleRow[] = []
): Promise<UpdateDraft> {
  const batchText = serializeBatchForPrompt(items, reposById);

  const result = await generateObject({
    model: process.env.GENERATION_MODEL ?? "anthropic/claude-sonnet-4-5",
    schema: UpdateDraftSchema,
    system: buildSystemPrompt(brandProfile, personas, examples),
    prompt: `Here are the changes to summarize into one product update. Format the body as Markdown (short paragraphs, and bullet lists where helpful):\n\n${batchText}`,
  });

  return result.object;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- generation`
Expected: PASS (existing tests + the two new ones — the existing "passes the repo-tagged batch…" test calls `generateUpdateDraft` with 4 args and still works because `examples` defaults to `[]`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/generation.ts tests/lib/generation.test.ts
git commit -m "feat: render few-shot examples into the generation prompt"
```

---

### Task 5: Load and select examples in `runBatchForWorkspace`

**Files:**
- Modify: `src/lib/run-schedule.ts`
- Test: `tests/lib/run-schedule.test.ts` (add a case)

**Interfaces:**
- Consumes: `systemUpdateExamples` table (Task 1), `systemPersonaKeys` (Task 2), `selectExamples` (Task 3), `generateUpdateDraft`'s `examples` param (Task 4).
- Produces: no new exports — `runBatchForWorkspace` now selects and passes examples into both generation attempts.

- [ ] **Step 1: Write the failing test**

In `tests/lib/run-schedule.test.ts`, add this test inside the `describe("run-schedule (workspace-level)", ...)` block. It relies on the migration-seeded `devtools-developer-new` example (Task 1) and requires importing `brandProfiles`:

Add `brandProfiles` to the schema import at the top of the file:

```ts
import { tenants, repos, changeItems, updates, scheduleConfigs, brandProfiles } from "../../src/db/schema";
```

Then add the test:

```ts
  it("selects matching seeded examples and injects them into the generation prompt", async () => {
    const { tenant, repoA } = await seed();
    // Brand profile whose industry + system persona match the seeded devtools/developer examples.
    await db.insert(brandProfiles).values({
      tenantId: tenant.id,
      industry: "Developer Tools",
      userPersonas: [{ type: "system", key: "developer" }],
    });
    await db.insert(changeItems).values({
      tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a",
    });
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: "T", body: "B", category: "new" },
    } as never);

    const pending = await getPendingChangeItems(tenant.id);
    await runBatchForWorkspace(tenant.id, pending);

    const system = vi.mocked(generateObject).mock.calls.at(-1)![0].system as string;
    expect(system).toContain("mirror their structure");
    expect(system).toContain("Ship webhooks with the new Events API"); // seeded devtools-developer-new title
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- run-schedule`
Expected: FAIL — `runBatchForWorkspace` does not load/select examples, so the system prompt contains neither the lead-in nor the seeded title.

- [ ] **Step 3: Wire selection into `runBatchForWorkspace`**

In `src/lib/run-schedule.ts`:

Add to the schema import (line 3, which already imports several tables) the examples table:

```ts
import { repos, scheduleConfigs, tenants, webhookConfigs, updates, systemPersonas, systemUpdateExamples } from "../db/schema";
```

Add these imports below the existing `resolvePersonaRefs` import:

```ts
import { resolvePersonaRefs, systemPersonaKeys } from "./personas";
import { selectExamples } from "./select-examples";
```

(Replace the existing `import { resolvePersonaRefs } from "./personas";` line with the first line above.)

In `runBatchForWorkspace`, after the personas are resolved (`const personas = resolvePersonaRefs(...)`), add:

```ts
  const allExamples = await database.select().from(systemUpdateExamples);
  const examples = selectExamples(allExamples, {
    industry: brandProfile.industry,
    personaKeys: systemPersonaKeys(brandProfile.userPersonas),
  });
```

Then update BOTH `generateUpdateDraft` calls (the initial attempt and the retry) to pass `examples`:

```ts
    draft = await generateUpdateDraft(pending, brandProfile, reposById, personas, examples);
```

(There are two such calls inside the try/catch retry block — update both identically.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- run-schedule`
Expected: PASS — the new test sees the injected example, and the existing run-schedule tests still pass (their tenants have no brand-profile industry/personas, so `selectExamples` returns `[]` and the prompt is unchanged).

- [ ] **Step 5: Run the full suite and type-check**

Run: `npm test`
Expected: all PASS.

Run: `npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/run-schedule.ts tests/lib/run-schedule.test.ts
git commit -m "feat: select and inject examples during batch generation"
```

---

## Self-Review

**Spec coverage:**
- Data model (`system_update_examples` + seed migration, ~12–16 examples, every row matchable) → Task 1 (14 examples seeded). ✓
- `selectExamples` strict scorer (industry/persona match, score ranking, sort_order tiebreak, cap 3, empty on no match, case-insensitive industry) → Task 3. ✓
- `systemPersonaKeys` criteria helper → Task 2. ✓
- Generation wiring (`examples` param, `buildSystemPrompt` block, `Example (<category>):` label, lead-in line) → Task 4. ✓
- `runBatchForWorkspace` loads catalog, derives criteria, selects, passes into both attempts → Task 5. ✓
- Testing: selectExamples pure; systemPersonaKeys pure; migration round-trip; generateUpdateDraft block present/absent; end-to-end injection → Tasks 1–5. ✓
- Scope boundaries: no tenant examples/UI; category not used in selection (only as label); examplePhrases/enrichment untouched. ✓

**Placeholder scan:** No TBD/TODO/"handle appropriately"/"similar to Task N". The seed INSERT and all code blocks are complete and literal. ✓

**Type consistency:** `ExampleRow = typeof systemUpdateExamples.$inferSelect` is defined identically in Tasks 3 and 4; `ExampleCriteria` fields (`industry`, `personaKeys`) match `systemPersonaKeys`'s output and `selectExamples`'s usage; column names (`personaKey`/`persona_key`, `sortOrder`/`sort_order`) are consistent between schema (Task 1) and consumers (Tasks 3–5). The seeded key `devtools-developer-new` and title `Ship webhooks with the new Events API` referenced in Task 5's test match Task 1's seed exactly. ✓

**Ordering:** Task 1 first. Tasks 2, 3, 4 depend only on Task 1 (2 needs nothing from 1; 3 and 4 need the `ExampleRow` type) and are mutually independent. Task 5 needs 1–4. So: 1 → {2, 3, 4} → 5.

**Note:** The spec says "~12–16 examples"; this plan seeds **14**, satisfying the "at least 12" test assertion and the spec's range.
