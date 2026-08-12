# Signals Absorb Atomic Updates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the Change events and Atomic updates tabs, moving evidence into a drawer on `/signals` and curation into two Company sections.

**Architecture:** No schema change. Server-side logic lifts out of the two route folders into `src/lib`, taking `tenantId` explicitly so it is testable without mocking Next internals. Thin `"use server"` wrappers call `requireSession()` and `revalidatePath()`. Signals gains a Dialog-based evidence drawer; Company gains a pipeline section for the un-windowed ledger and bulk operations.

**Tech Stack:** Next.js 16.2.10 App Router, Drizzle ORM 0.45.2, Postgres, Base UI (`@base-ui/react/dialog`), Vitest.

## Open decision — blocks Task 6 only

Two components in the dying folders were not accounted for in the spec. Tasks 1–5 do not depend on the answer; **Task 6 must not run until it is settled.**

1. **`atomic-updates/draft-release-dialog.tsx`** posts to `/api/atomic-updates/draft` — the live "select shipped work → compose a product update" flow, with its own streamed progress (`DRAFT_STEPS`, `DraftProgressEvent`). Retiring the tab removes the only entry point to it. Either it relocates to the Company atomic-updates section, or it retires on the grounds that the manual-brief path now covers the same ground (`briefs/new` calls `listSignals(tenantId, {})` with no kind restriction, so `shipped_work` signals are already selectable into a brief). **This is a product decision, not a mechanical one.**

2. **`change-events/import-dialog.tsx` + `import-actions.ts`** — the manual GitHub/Notion import subsystem, rendered by *both* dying pages via `listImportRepos`. The spec said repo import "stays where it is" under Integrations; that was wrong, it lives in the change-events folder today. Task 5 gives it an explicit home. No decision needed.

## Global Constraints

- **Read the relevant guide in `node_modules/next/dist/docs/` before writing route code.** This Next.js has breaking changes from training data.
- **Tenant scoping is the security boundary**, enforced per-query in the WHERE clause, not by RLS. Every read and mutation added here takes `tenantId` from the session and never from client input. A signal id, atomic update id, or event id arriving from the browser is untrusted.
- **`revalidatePath` and `requireSession` stay in the `"use server"` layer.** `src/lib` modules take `tenantId` (and `userId` where needed) as parameters and accept an injectable `database` argument defaulting to the shared `db` — the exact shape of `src/lib/content/board.ts`. A `revalidatePath` call inside a lib module breaks its tests.
- **`"use server"` files may export ONLY async functions.** A synchronous export — including a `const`, a type alias re-export, or a helper — breaks `npm run build` while the whole test suite still passes. This has bitten this project twice.
- **Never import a runtime value from a server module into a `"use client"` file.** Importing *any* export from a module with a top-level `db` import pulls `pg` into the client bundle; Next does not tree-shake it. Type-only imports (`import type`) are safe.
- **`npm run build` is a mandatory gate on every task that touches a route or component.** The suite does not catch either failure mode above.
- The UI cannot be visually verified — the dev preview is behind an OAuth wall. Rely on `tsc`, `eslint`, and the build.
- Fixture minimums: `atomicUpdates` requires `tenantId`, `title`, `summary`. `changeEvents` requires `tenantId`, `type`, `provider`, `externalId`. All other columns have defaults.
- Tests live in `tests/`, mirroring `src/`. Run with `npm test`. **The suite is flaky against its shared Postgres — run a failing file twice before believing it, and check whether it is one you touched.**

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/change-events/event-label.ts` | The type-aware evidence label, shared by the drawer and the ledger |
| `src/lib/signals/evidence.ts` | `readSignalEvidence` — one signal's atomic update and its change events |
| `src/lib/atomic-updates/list.ts` | The ledger read and the eight curation mutations, tenant-parameterized |
| `src/lib/change-events/list.ts` | The change-event read and the bulk mutations, tenant-parameterized |
| `src/app/(dashboard)/signals/evidence-drawer.tsx` | The drawer, a client component |
| `src/app/(dashboard)/signals/evidence-actions.ts` | `"use server"` wrappers the drawer calls |
| `src/app/(dashboard)/company/change-events-section.tsx` | Ungrouped queue with its empty state |
| `src/app/(dashboard)/company/atomic-updates-section.tsx` | All-time ledger with bulk operations |

---

### Task 1: Shared event label and the drawer read

**Files:**
- Create: `src/lib/change-events/event-label.ts`
- Create: `src/lib/signals/evidence.ts`
- Test: `tests/lib/signals/evidence.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `eventLabel(event)`, `readSignalEvidence(tenantId, signalId, database?)`, and the types `EvidenceEvent` / `SignalEvidence`. Tasks 2, 4 and 5 all import these.

> **Do not unify the two title fallbacks.** `eventLabel` below is type-aware (a commit prefers its first message line; everything else prefers `prTitle`, then `taskTitle`). `listChangeEvents` uses a different, flat order (`prTitle ?? firstLine ?? taskTitle`). They are deliberately different and both are covered by existing tests. Moving `eventLabel` to a shared module is a relocation, **not** an invitation to make `listChangeEvents` use it.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/signals/evidence.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, atomicUpdates, changeEvents, signals } from "../../../src/db/schema";
import { readSignalEvidence } from "../../../src/lib/signals/evidence";

const TENANT = "Signal Evidence Test Tenant";
const OTHER_TENANT = "Signal Evidence Other Tenant";

async function seedTenant(name: string) {
  const [tenant] = await db.insert(tenants).values({ name }).returning();
  return tenant;
}

describe("readSignalEvidence", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
    await db.delete(tenants).where(eq(tenants.name, OTHER_TENANT));
  });

  it("returns the atomic update and its change events", async () => {
    const tenant = await seedTenant(TENANT);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "SAML SSO", summary: "Teams can log in with SAML." })
      .returning();
    await db.insert(changeEvents).values({
      tenantId: tenant.id,
      type: "pull_request",
      provider: "github",
      externalId: "pr-1",
      prTitle: "Add SAML handshake",
      externalUrl: "https://example.test/pr/1",
      atomicUpdateId: atomic.id,
    });
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        kind: "shipped_work",
        externalId: atomic.id,
        title: "SAML SSO",
        occurredAt: new Date(),
        atomicUpdateId: atomic.id,
      })
      .returning();

    const evidence = await readSignalEvidence(tenant.id, signal.id);

    expect(evidence).not.toBeNull();
    expect(evidence!.atomicUpdateId).toBe(atomic.id);
    expect(evidence!.title).toBe("SAML SSO");
    expect(evidence!.summary).toBe("Teams can log in with SAML.");
    expect(evidence!.hidden).toBe(false);
    expect(evidence!.events).toHaveLength(1);
    expect(evidence!.events[0].label).toBe("Add SAML handshake");
    expect(evidence!.events[0].externalUrl).toBe("https://example.test/pr/1");
  });

  it("returns null for a signal with no atomic update", async () => {
    const tenant = await seedTenant(TENANT);
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        kind: "market_news",
        externalId: "https://example.test/article",
        title: "Industry piece",
        occurredAt: new Date(),
      })
      .returning();

    expect(await readSignalEvidence(tenant.id, signal.id)).toBeNull();
  });

  it("refuses a signal belonging to another tenant", async () => {
    const owner = await seedTenant(TENANT);
    const stranger = await seedTenant(OTHER_TENANT);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: owner.id, title: "Private", summary: "Not yours." })
      .returning();
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: owner.id,
        kind: "shipped_work",
        externalId: atomic.id,
        title: "Private",
        occurredAt: new Date(),
        atomicUpdateId: atomic.id,
      })
      .returning();

    // Asserted by id, not by an empty result: a query that forgot the tenant
    // filter would still return this row.
    expect(await readSignalEvidence(stranger.id, signal.id)).toBeNull();
  });

  it("returns a hidden atomic update with hidden set", async () => {
    const tenant = await seedTenant(TENANT);
    const [atomic] = await db
      .insert(atomicUpdates)
      .values({ tenantId: tenant.id, title: "Hidden one", summary: "S", status: "hidden" })
      .returning();
    const [signal] = await db
      .insert(signals)
      .values({
        tenantId: tenant.id,
        kind: "shipped_work",
        externalId: atomic.id,
        title: "Hidden one",
        occurredAt: new Date(),
        atomicUpdateId: atomic.id,
      })
      .returning();

    const evidence = await readSignalEvidence(tenant.id, signal.id);
    expect(evidence!.hidden).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/signals/evidence.test.ts`
Expected: FAIL — cannot resolve `../../../src/lib/signals/evidence`.

- [ ] **Step 3: Write `src/lib/change-events/event-label.ts`**

Move the function verbatim out of `src/app/(dashboard)/atomic-updates/actions.ts` (lines 20–39), keeping its doc comment:

```ts
/**
 * The display label for a piece of evidence, mirroring the title fallback in
 * `listChangeEvents` (prTitle → commit first line → taskTitle → "Untitled").
 *
 * A Notion task keeps its title in `taskTitle`, NOT `prTitle` (see
 * ingest-notion-task.ts), so a chain that stops at `prTitle` renders task
 * evidence as an empty string — which used to leave nothing but a "Task" chip
 * on the row. `"Untitled"` closes the last gap: an empty label would now be an
 * invisible, unclickable evidence row.
 */
export function eventLabel(event: {
  type: "commit" | "pull_request" | "task";
  prTitle: string | null;
  commitMessage: string | null;
  taskTitle: string | null;
}): string {
  const firstLine = event.commitMessage?.split("\n")[0]?.trim();
  if (event.type === "commit") return firstLine || event.prTitle || "Untitled";
  return event.prTitle || event.taskTitle || firstLine || "Untitled";
}
```

Then delete it from `actions.ts` and import it there instead — that file still uses it until Task 2.

- [ ] **Step 4: Write `src/lib/signals/evidence.ts`**

```ts
import { and, asc, eq } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, changeEvents, signals } from "@/db/schema";
import { eventLabel } from "@/lib/change-events/event-label";

type Database = typeof defaultDb;

export type EvidenceEvent = {
  id: string;
  type: (typeof changeEvents.$inferSelect)["type"];
  provider: (typeof changeEvents.$inferSelect)["provider"];
  label: string;
  externalUrl: string | null;
  createdAt: Date;
};

export type SignalEvidence = {
  atomicUpdateId: string;
  title: string;
  summary: string;
  category: (typeof atomicUpdates.$inferSelect)["category"];
  size: (typeof atomicUpdates.$inferSelect)["size"];
  hidden: boolean;
  events: EvidenceEvent[];
};

/**
 * One signal's evidence: the atomic update it mirrors, plus the change events
 * behind that update.
 *
 * Returns null when the signal has no `atomicUpdateId` — every non-shipped_work
 * kind, and a shipped_work signal whose atomic update was deleted (the FK is
 * ON DELETE SET NULL, because the signal is the durable record of what
 * happened). The drawer renders nothing in that case rather than an error.
 *
 * The signal lookup is tenant-scoped, and the atomic-update lookup is scoped
 * again independently: the id comes from a row we just tenant-checked, but the
 * where clause is the security boundary in this codebase and each query carries
 * its own.
 */
export async function readSignalEvidence(
  tenantId: string,
  signalId: string,
  database: Database = defaultDb
): Promise<SignalEvidence | null> {
  const [signal] = await database
    .select({ atomicUpdateId: signals.atomicUpdateId })
    .from(signals)
    .where(and(eq(signals.id, signalId), eq(signals.tenantId, tenantId)))
    .limit(1);

  if (!signal?.atomicUpdateId) return null;

  const [atomic] = await database
    .select({
      id: atomicUpdates.id,
      title: atomicUpdates.title,
      summary: atomicUpdates.summary,
      category: atomicUpdates.category,
      size: atomicUpdates.size,
      status: atomicUpdates.status,
    })
    .from(atomicUpdates)
    .where(and(eq(atomicUpdates.id, signal.atomicUpdateId), eq(atomicUpdates.tenantId, tenantId)))
    .limit(1);

  if (!atomic) return null;

  // Ordered by createdAt then id: events ingested in the same webhook batch
  // share a createdAt, and SQL guarantees no order among equal sort keys — the
  // id tiebreaker keeps the drawer's list stable across opens.
  const events = await database
    .select({
      id: changeEvents.id,
      type: changeEvents.type,
      provider: changeEvents.provider,
      prTitle: changeEvents.prTitle,
      commitMessage: changeEvents.commitMessage,
      taskTitle: changeEvents.taskTitle,
      externalUrl: changeEvents.externalUrl,
      createdAt: changeEvents.createdAt,
    })
    .from(changeEvents)
    .where(and(eq(changeEvents.tenantId, tenantId), eq(changeEvents.atomicUpdateId, atomic.id)))
    .orderBy(asc(changeEvents.createdAt), asc(changeEvents.id));

  return {
    atomicUpdateId: atomic.id,
    title: atomic.title,
    summary: atomic.summary,
    category: atomic.category,
    size: atomic.size,
    hidden: atomic.status === "hidden",
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      provider: e.provider,
      label: eventLabel(e),
      externalUrl: e.externalUrl,
      createdAt: e.createdAt,
    })),
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/signals/evidence.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Delete each guard and confirm its test fails**

Per the standing rule, one at a time, reverting after each:
- Remove `eq(signals.tenantId, tenantId)` → the cross-tenant test must fail.
- Remove `eq(atomicUpdates.tenantId, tenantId)` → the cross-tenant test must fail.
- Remove `eq(changeEvents.tenantId, tenantId)` → seed a same-id event under the other tenant if needed to make this observable; if it cannot be made to fail, say so rather than leaving an unguarded query.
- Change `if (!signal?.atomicUpdateId) return null` to `if (!signal) return null` → the null-atomic-update test must fail.

- [ ] **Step 7: Commit**

```bash
git add src/lib/change-events/event-label.ts src/lib/signals/evidence.ts tests/lib/signals/evidence.test.ts "src/app/(dashboard)/atomic-updates/actions.ts"
git commit -m "feat: read a signal's atomic update and change events"
```

---

### Task 2: Lift atomic-update curation into `src/lib`

**Files:**
- Create: `src/lib/atomic-updates/list.ts`
- Modify: `src/app/(dashboard)/atomic-updates/actions.ts` — becomes a thin wrapper
- Test: `tests/lib/atomic-updates/list.test.ts` (moved from `tests/app/atomic-updates-actions.test.ts`)

**Interfaces:**
- Consumes: `eventLabel` from Task 1.
- Produces: `listAtomicUpdates(tenantId, filters, database?)`, `hasCuratableAtomicUpdates(tenantId, database?)`, `hideAtomicUpdate(tenantId, id, database?)`, `bulkHideAtomicUpdates(tenantId, ids, database?)`, `bulkDeleteAtomicUpdates(tenantId, ids, database?)`, `unhideAtomicUpdate(tenantId, id, database?)`, `editAtomicUpdate(tenantId, id, patch, database?)`, `setAtomicUpdateSize(tenantId, id, size, database?)`, `setAtomicUpdateCategory(tenantId, id, category, database?)`, `removeEventFromAtomicUpdate({tenantId, userId, atomicUpdateId, eventId, confirmEmptyDeletion})`, plus the types `AtomicUpdateRow`, `AtomicUpdateEvent`, `AtomicUpdateListFilters`. Tasks 4 and 5 import these.

> This is a **mechanical lift, not a rewrite.** Every WHERE guard, every doc comment, and every behaviour in `src/app/(dashboard)/atomic-updates/actions.ts` must survive verbatim. The only changes: `const session = await requireSession()` and its `session.user.tenantId` reads become the `tenantId` parameter; `session.user.id` becomes `userId`; `db` becomes the injectable `database`; and every `revalidatePath` call is **deleted from the lib module** and re-added in the wrapper.

- [ ] **Step 1: Move the existing test file and re-point it**

```bash
mkdir -p tests/lib/atomic-updates
git mv tests/app/atomic-updates-actions.test.ts tests/lib/atomic-updates/list.test.ts
```

Change its import from the route actions to `../../../src/lib/atomic-updates/list`, and update every call site to pass `tenant.id` as the first argument. Whatever `requireSession` mocking the file currently does is **deleted** — that is the entire point of the move.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/atomic-updates/list.test.ts`
Expected: FAIL — cannot resolve `../../../src/lib/atomic-updates/list`.

- [ ] **Step 3: Create `src/lib/atomic-updates/list.ts`**

Copy the whole body of `src/app/(dashboard)/atomic-updates/actions.ts` except the `"use server"` directive, the `revalidatePath` import, and the `eventLabel` definition (now imported from Task 1). Apply the parameter substitution described above. The signature shape, using `hideAtomicUpdate` as the worked example:

```ts
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { atomicUpdates, changeEvents } from "@/db/schema";
import { eventLabel } from "@/lib/change-events/event-label";
import { reassignChangeEvent, type ReassignResult } from "@/lib/change-events/reassign";

type Database = typeof defaultDb;

// ... AtomicUpdateEvent, AtomicUpdateRow, AtomicUpdateListFilters unchanged ...

export async function hideAtomicUpdate(
  tenantId: string,
  id: string,
  database: Database = defaultDb
): Promise<{ ok: boolean }> {
  const rows = await database
    .update(atomicUpdates)
    .set({ status: "hidden", updatedAt: new Date() })
    .where(
      and(
        eq(atomicUpdates.id, id),
        eq(atomicUpdates.tenantId, tenantId),
        eq(atomicUpdates.status, "open"),
        isNull(atomicUpdates.contentPieceId)
      )
    )
    .returning({ id: atomicUpdates.id });

  return { ok: rows.length > 0 };
}
```

`removeEventFromAtomicUpdate` needs both ids, so it takes an object rather than growing a fourth positional:

```ts
export async function removeEventFromAtomicUpdate(input: {
  tenantId: string;
  userId: string;
  atomicUpdateId: string;
  eventId: string;
  confirmEmptyDeletion?: boolean;
  database?: Database;
}): Promise<ReassignResult> {
  const { tenantId, userId, atomicUpdateId, eventId, confirmEmptyDeletion } = input;
  const database = input.database ?? defaultDb;

  const [event] = await database
    .select({ atomicUpdateId: changeEvents.atomicUpdateId })
    .from(changeEvents)
    .where(and(eq(changeEvents.id, eventId), eq(changeEvents.tenantId, tenantId)))
    .limit(1);

  if (!event || event.atomicUpdateId !== atomicUpdateId) {
    return { ok: false, reason: "Change event does not belong to this atomic update." };
  }

  return reassignChangeEvent({
    tenantId,
    userId,
    eventId,
    target: { kind: "detach" },
    confirmEmptyDeletion,
    forceRegenerate: true,
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/atomic-updates/list.test.ts`
Expected: PASS, same count as before the move.

- [ ] **Step 5: Rewrite the route actions as a thin wrapper**

Replace `src/app/(dashboard)/atomic-updates/actions.ts` entirely. Every export stays async (the `"use server"` rule), delegates, and owns the `revalidatePath`. Types are **not** re-exported from here — a `"use server"` file may export only async functions, and Task 5's components import the types from `@/lib/atomic-updates/list` directly.

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/workspace/session";
import * as curation from "@/lib/atomic-updates/list";

export async function hideAtomicUpdate(id: string) {
  const session = await requireSession();
  const result = await curation.hideAtomicUpdate(session.user.tenantId, id);
  revalidatePath("/company");
  return result;
}

// ... the same shape for unhideAtomicUpdate, bulkHideAtomicUpdates,
// bulkDeleteAtomicUpdates, editAtomicUpdate, setAtomicUpdateSize,
// setAtomicUpdateCategory, listAtomicUpdates, hasCuratableAtomicUpdates ...

export async function removeEventFromAtomicUpdate(
  atomicUpdateId: string,
  eventId: string,
  confirmEmptyDeletion?: boolean
) {
  const session = await requireSession();
  const result = await curation.removeEventFromAtomicUpdate({
    tenantId: session.user.tenantId,
    userId: session.user.id,
    atomicUpdateId,
    eventId,
    confirmEmptyDeletion,
  });
  revalidatePath("/company");
  return result;
}
```

Note the revalidate target is now `/company`, not `/atomic-updates` — the page it refreshes moves in Task 5. The read functions (`listAtomicUpdates`, `hasCuratableAtomicUpdates`) do **not** revalidate.

- [ ] **Step 6: Verify the build and the full suite**

Run: `npm run build && npm test`
Expected: build succeeds (this is the `"use server"` export-shape gate), suite passes.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: lift atomic-update curation into lib"
```

---

### Task 3: Lift change-event listing and bulk mutations into `src/lib`

**Files:**
- Create: `src/lib/change-events/list.ts`
- Modify: `src/app/(dashboard)/change-events/actions.ts` — becomes a thin wrapper
- Test: `tests/lib/change-events/list.test.ts` (moved from `tests/app/change-events-actions.test.ts`)

**Interfaces:**
- Consumes: `reassignChangeEvent` from the existing `src/lib/change-events/reassign.ts` (unchanged).
- Produces: `listChangeEvents(tenantId, filters, database?)`, `bulkReassignChangeEvents({tenantId, userId, eventIds, target})`, `bulkDeleteChangeEvents(tenantId, eventIds, database?)`, `listImportRepos(tenantId, database?)`, plus `ChangeEventRow` and `ChangeEventFilters`. Task 5 imports these.

> Same rule as Task 2: **mechanical lift.** The three-valued-logic comment on `explicitlyNotUserFacing` and the `NOT EXISTS … status = 'released'` guard in `bulkDeleteChangeEvents` are load-bearing and must survive verbatim.
>
> **`reassign(formData)` stays in the route actions file.** It parses `FormData`, which is a route concern, and its `parseTarget` / `parseConfirmEmptyDeletion` helpers are synchronous — they cannot live in a `"use server"` module's export surface, so they stay as module-private functions in the wrapper. It delegates to `reassignChangeEvent`, which already lives in lib.

- [ ] **Step 1: Move the existing test file and re-point it**

```bash
git mv tests/app/change-events-actions.test.ts tests/lib/change-events/list.test.ts
```

Re-point imports to `../../../src/lib/change-events/list`, pass `tenant.id` explicitly, drop the session mocking. Any test that exercises `reassign(formData)` **stays behind** in a trimmed `tests/app/change-events-actions.test.ts` — that function is not moving.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/change-events/list.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/change-events/list.ts`**

Copy from `src/app/(dashboard)/change-events/actions.ts`: `ImportRepo`, `ChangeEventRow`, `ChangeEventFilters`, `listChangeEvents`, `bulkReassignChangeEvents`, `bulkDeleteChangeEvents`, `listImportRepos`. Substitute parameters as in Task 2 and drop every `revalidatePath`.

```ts
export async function listChangeEvents(
  tenantId: string,
  filters: ChangeEventFilters,
  database: Database = defaultDb
): Promise<ChangeEventRow[]> {
  // body unchanged from the route action, with `tenantId` used directly and
  // `db` replaced by `database`
}

export async function bulkReassignChangeEvents(input: {
  tenantId: string;
  userId: string;
  eventIds: string[];
  target: { kind: "existing"; atomicUpdateId: string } | { kind: "detach" };
}): Promise<{ succeeded: number; failed: number; deletedAtomicUpdates: number }> {
  // body unchanged
}
```

- [ ] **Step 4: Add a test for the ungrouped read**

Append to `tests/lib/change-events/list.test.ts` — Task 5's empty state depends on this returning empty rather than throwing:

```ts
it("returns only unassigned events, and empty when everything is grouped", async () => {
  const tenant = await seedTenant();
  const [atomic] = await db
    .insert(atomicUpdates)
    .values({ tenantId: tenant.id, title: "Grouped", summary: "S" })
    .returning();
  await db.insert(changeEvents).values({
    tenantId: tenant.id,
    type: "pull_request",
    provider: "github",
    externalId: "pr-grouped",
    prTitle: "Already grouped",
    atomicUpdateId: atomic.id,
  });

  expect(await listChangeEvents(tenant.id, { assignment: "unassigned" })).toEqual([]);

  await db.insert(changeEvents).values({
    tenantId: tenant.id,
    type: "pull_request",
    provider: "github",
    externalId: "pr-loose",
    prTitle: "Not grouped",
    userFacing: true,
  });

  const loose = await listChangeEvents(tenant.id, { assignment: "unassigned" });
  expect(loose).toHaveLength(1);
  expect(loose[0].title).toBe("Not grouped");
});
```

> `userFacing: true` on the second insert is deliberate. An unassigned event that is not explicitly user-facing is hidden by the default `showHidden: false` rule — omit it and this test asserts the wrong thing for the wrong reason.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/change-events/list.test.ts`
Expected: PASS.

- [ ] **Step 6: Rewrite the route actions as a thin wrapper**

Keep `reassign` and its two private parsers in place; replace the rest with delegating async exports that `revalidatePath("/company")`.

- [ ] **Step 7: Verify the build and the full suite**

Run: `npm run build && npm test`
Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: lift change-event listing into lib"
```

---

### Task 4: The evidence drawer

**Files:**
- Create: `src/app/(dashboard)/signals/evidence-drawer.tsx`
- Create: `src/app/(dashboard)/signals/evidence-actions.ts`
- Modify: `src/app/(dashboard)/signals/signal-row.tsx`
- Test: `tests/components/evidence-drawer.test.tsx`

**Interfaces:**
- Consumes: `SignalEvidence` / `EvidenceEvent` types and `readSignalEvidence` from Task 1; the curation mutations from Task 2.
- Produces: `<EvidenceDrawer signalId title />`, rendered by `SignalRow`.

- [ ] **Step 1: Write `src/app/(dashboard)/signals/evidence-actions.ts`**

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/workspace/session";
import { readSignalEvidence, type SignalEvidence } from "@/lib/signals/evidence";
import { editAtomicUpdate, setAtomicUpdateSize, setAtomicUpdateCategory, hideAtomicUpdate, removeEventFromAtomicUpdate } from "@/lib/atomic-updates/list";

export async function loadSignalEvidence(signalId: string): Promise<SignalEvidence | null> {
  const session = await requireSession();
  return readSignalEvidence(session.user.tenantId, signalId);
}

export async function saveEvidenceEdit(
  atomicUpdateId: string,
  patch: { title: string; summary: string }
): Promise<void> {
  const session = await requireSession();
  await editAtomicUpdate(session.user.tenantId, atomicUpdateId, patch);
  revalidatePath("/signals");
}

// ... same shape for size, category, hide, and remove-event ...
```

- [ ] **Step 2: Write the drawer**

`evidence-drawer.tsx` is `"use client"`. It imports **types only** from `@/lib/signals/evidence` (`import type { SignalEvidence }`) and calls the server actions above — never `readSignalEvidence` directly, which would pull `pg` into the client bundle.

Behaviour: closed by default; on open, calls `loadSignalEvidence(signalId)` and shows a loading state, then renders the atomic update's title and summary in editable fields, `category` and `size` selects, a Hide control, and the event list with per-event remove. Built on `Dialog` from `@/components/ui/dialog`.

- [ ] **Step 3: Render the control in `SignalRow`**

Add to the right-hand badge cluster, gated on kind:

```tsx
{row.kind === "shipped_work" && <EvidenceDrawer signalId={row.id} title={row.title} />}
```

Non-`shipped_work` signals have no atomic update and must not render a control that can only ever return null.

- [ ] **Step 4: Write the component test**

`tests/components/evidence-drawer.test.tsx`, following the conventions of the existing files in `tests/components/`: the drawer is closed initially, opening calls the load action once, and a `null` result renders the no-evidence state rather than throwing.

- [ ] **Step 5: Run tests, typecheck, lint, and build**

Run: `npx vitest run tests/components/evidence-drawer.test.tsx && npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass. **The build is the gate that catches a server-module leak into this client component** — the exact failure mode this task is most exposed to.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: evidence drawer on shipped-work signals"
```

---

### Task 5: The Company pipeline sections

**Files:**
- Create: `src/app/(dashboard)/company/change-events-section.tsx`
- Create: `src/app/(dashboard)/company/atomic-updates-section.tsx`
- Modify: `src/app/(dashboard)/company/page.tsx`

**Interfaces:**
- Consumes: the reads and mutations from Tasks 2 and 3.
- Produces: two `Card` sections rendered by `CompanyPage`.

- [ ] **Step 1: Build the change-events section**

Ungrouped queue: calls `listChangeEvents(tenantId, { assignment: "unassigned" })`. Carries the `type`, `provider` and `showHidden` filters, reassign, bulk reassign, and bulk delete — lifted from the existing `/change-events` page components, which are reused rather than rewritten.

**Empty state is required.** When the list is empty, render a plain sentence saying everything is grouped — not an empty table. This is the healthy state and must read as such.

- [ ] **Step 2: Build the atomic-updates section**

The all-time ledger: `listAtomicUpdates(tenantId, filters)` with the `category`, `size` and `showHidden` filters, plus bulk hide, bulk delete, and unhide. Reuse the existing card and filter components from `/atomic-updates`.

This section is deliberately **not** windowed to 60 days — it is the only surface where an atomic update older than `SIGNAL_WINDOW_DAYS` is reachable, because `syncShippedWorkSignals` never created a signal for it.

Components to move rather than rewrite, from `src/app/(dashboard)/atomic-updates/`: `atomic-update-card.tsx`, `atomic-updates-filters.tsx`, `atomic-updates-list.tsx`, `add-event-picker.tsx`. Re-point their action imports at the Task 2 wrapper.

- [ ] **Step 2b: Relocate the manual import subsystem to Integrations**

`change-events/import-dialog.tsx` and `change-events/import-actions.ts` are the GitHub/Notion manual import, rendered by both dying pages through `listImportRepos`. Move both to `src/app/(dashboard)/integrations/`, where the connected repos they act on already live, and render the dialog from the Integrations page.

`import-actions.ts` is already a `"use server"` module with its own `requireSession()`; it moves as-is apart from its `revalidatePath` targets, which become `/company`. Its tests in `tests/app/import-actions-tasks.test.ts` move with it and must still pass.

Components to move from `src/app/(dashboard)/change-events/`: `change-event-row.tsx`, `change-events-filters.tsx`, `change-events-list.tsx`, `reassign-control.tsx`.

- [ ] **Step 3: Wire both into `company/page.tsx`**

Append after the existing Guidelines card, matching the page's `Card` / `CardHeader` / `CardDescription` / `CardContent` shape. `CompanyPage` is already an async Server Component with `requireSession()` — pass `session.user.tenantId` into the reads there.

- [ ] **Step 4: Typecheck, lint, build**

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: pipeline sections on the company page"
```

---

### Task 6: Retire the two tabs

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/app/(dashboard)/nav-links.tsx`
- Modify: `src/app/(dashboard)/settings/actions.ts:45` and `:75`
- Replace: `src/app/(dashboard)/atomic-updates/` and `src/app/(dashboard)/change-events/` with redirect stubs

**Interfaces:**
- Consumes: everything from Tasks 4 and 5 — this task is last because it removes the old surfaces.
- Produces: nothing new.

> **`src/app/api/atomic-updates/draft/route.ts` must not be touched.** It shares a path prefix with the retired tab and is an unrelated API route. Deleting it is the single most likely mistake in this task.

- [ ] **Step 1: Retarget the root redirect**

`src/app/page.tsx:8` currently sends every onboarded user to `/atomic-updates` — the app's post-login landing page. Change the completed branch to `/briefs`:

```ts
redirect(complete ? "/briefs" : "/onboarding");
```

Not `/company`: following the tab's own redirect would land users on settings, which is the wrong first screen.

- [ ] **Step 2: Remove the two nav entries**

Delete the `/change-events` (line 22) and `/atomic-updates` (line 27) entries from `src/app/(dashboard)/nav-links.tsx`, and their now-unused `Activity` and `ToyBrick` icon imports. Navigation goes from ten items to eight.

- [ ] **Step 3: Retarget the stale revalidate calls**

`src/app/(dashboard)/settings/actions.ts` lines 45 and 75 call `revalidatePath("/atomic-updates")`. Both become `revalidatePath("/company")`.

- [ ] **Step 4: Replace the route folders with redirect stubs**

Delete every file in both folders, then create one `page.tsx` each:

```tsx
import { redirect } from "next/navigation";

// Both tabs retired in favour of /signals (evidence) and /company (curation).
// A redirect rather than a 404: these were in the nav for the life of the
// project and will be bookmarked.
export default function Page() {
  redirect("/company");
}
```

Any component from these folders still needed by Task 5's sections must have been moved to `company/` in Task 5, not left behind — confirm with `npx tsc --noEmit` before deleting.

- [ ] **Step 5: Confirm nothing still points at the old routes**

Run:

```bash
grep -rn "/atomic-updates\|/change-events" src --include="*.ts" --include="*.tsx" | grep -v "app/api/atomic-updates\|lib/change-events\|app/(dashboard)/atomic-updates/page.tsx\|app/(dashboard)/change-events/page.tsx"
```

Expected: no output. Hits under `src/lib/change-events/` and `src/app/api/atomic-updates/` are correct and must remain.

- [ ] **Step 6: Full verification**

Run: `npx tsc --noEmit && npm run lint && npm run build && npm test`
Expected: all pass. Re-run any failing test file once before believing it — the suite is flaky against its shared Postgres.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: retire the change-events and atomic-updates tabs"
```

---

## Deferred

Recorded in the spec, not built here:

- Deleting `category` and `size`, which nothing outside the curation UI reads.
- Closing the reconciler lag by having a drawer edit sync just the one atomic update it touched — needs a narrower entry point than the tenant-wide sweep.
- Retiring `/drafts` in favour of the board, still open from spec 7.
