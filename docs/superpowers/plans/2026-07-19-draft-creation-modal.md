# Draft-creation Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Draft update now" action with a modal that previews the draft, creates it while streaming real step-by-step progress, and ends in an inline error or a success state linking to the draft.

**Architecture:** A shared progress-event contract; `runBatchForWorkspace` / `reviewAndReconcile` gain an optional `onProgress` callback; a streaming NDJSON route drives a client modal state machine. The old `runNow` → `/pending/schedule-choice` flow is removed.

**Tech Stack:** Next.js (App Router route handlers + `ReadableStream`), server actions, Drizzle, next-auth (`getServerSession`), Base UI Dialog, Vitest.

## Global Constraints

- Patched Next.js: verify route-handler streaming (`Response` with a `ReadableStream` body) and `getServerSession(authOptions)` usage inside a route against `node_modules/next/dist/docs` before writing those files.
- `runBatchForWorkspace` MUST keep returning `boolean` and behave identically when `onProgress` is omitted (the scheduled path in `runSchedulerTick` must be unaffected).
- Every draft request ends in exactly one terminal event: `{type:"done"}` or `{type:"error"}`.
- Events are newline-delimited JSON (`JSON.stringify(event) + "\n"`).
- Step keys and order: `collecting`, `preparing`, `generating`, `reviewing`, `saving`.

---

### Task 1: Progress contract + backend emission

**Files:**
- Create: `src/lib/scheduling/draft-progress.ts`
- Modify: `src/lib/ai/review-draft.ts` (`reviewAndReconcile`)
- Modify: `src/lib/scheduling/run-schedule.ts` (`runBatchForWorkspace`)
- Test: `tests/lib/scheduling/run-schedule.test.ts`

**Interfaces:**
- Produces: `DraftProgressEvent`, `OnDraftProgress`, `DRAFT_STEPS` (from draft-progress.ts). `runBatchForWorkspace(tenantId, pending, database?, onProgress?)` and `reviewAndReconcile(draft, brandProfile, onProgress?)` both gain a trailing optional `onProgress`.

- [ ] **Step 1: Create the shared contract**

Create `src/lib/scheduling/draft-progress.ts`:

```ts
export type DraftStepKey = "collecting" | "preparing" | "generating" | "reviewing" | "saving";

export type DraftProgressEvent =
  | { type: "step"; key: DraftStepKey; status: "start" | "done" }
  | { type: "detail"; text: string }
  | { type: "done"; updateId: string }
  | { type: "error"; message: string };

export type OnDraftProgress = (event: DraftProgressEvent) => void;

export const DRAFT_STEPS: { key: DraftStepKey; label: string }[] = [
  { key: "collecting", label: "Collecting pending changes" },
  { key: "preparing", label: "Preparing brand profile & examples" },
  { key: "generating", label: "Generating the draft" },
  { key: "reviewing", label: "Reviewing against brand guidelines" },
  { key: "saving", label: "Saving the draft" },
];
```

- [ ] **Step 2: Add per-round detail to reviewAndReconcile**

In `src/lib/ai/review-draft.ts`, import the type and thread an optional `onProgress` through `reviewAndReconcile`:

```ts
import type { OnDraftProgress } from "@/lib/scheduling/draft-progress";
```

Change the signature and emit a `detail` event at each review/revise round (leave all existing logic — retries, rounds, outcomes — unchanged):

```ts
export async function reviewAndReconcile(
  draft: UpdateDraft,
  brandProfile: BrandProfileRow,
  onProgress?: OnDraftProgress
): Promise<ReviewOutcome> {
  const rounds = reviewMaxRounds();
  let current = draft;

  try {
    onProgress?.({ type: "detail", text: "Reviewing (round 1)" });
    let critique = await withRetry(() => reviewDraft(current, brandProfile));
    if (critique.compliant) return { finalDraft: current, status: "passed", issues: [] };

    for (let round = 0; round < rounds; round++) {
      onProgress?.({ type: "detail", text: "Revising" });
      current = await withRetry(() => reviseDraft(current, critique.issues, brandProfile));
      onProgress?.({ type: "detail", text: `Reviewing (round ${round + 2})` });
      critique = await withRetry(() => reviewDraft(current, brandProfile));
      if (critique.compliant) return { finalDraft: current, status: "revised", issues: [] };
    }

    return { finalDraft: current, status: "failed", issues: critique.issues };
  } catch {
    return { finalDraft: current, status: "error", issues: [] };
  }
}
```

- [ ] **Step 3: Write the failing test for runBatchForWorkspace progress**

In `tests/lib/scheduling/run-schedule.test.ts`, add two tests inside the `describe("run-schedule (workspace-level)", ...)` block. (`generateObject` and `reviewAndReconcile` are already mocked at the top of this file.)

```ts
it("runBatchForWorkspace emits ordered progress events and a done event on success", async () => {
  const { tenant, repoA } = await seed();
  await db.insert(changeItems).values({
    tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "a",
  });
  vi.mocked(generateObject).mockResolvedValue({
    object: { title: "T", body: "B", category: "new" },
  } as never);

  const events: import("../../../src/lib/scheduling/draft-progress").DraftProgressEvent[] = [];
  const pending = await getPendingChangeItems(tenant.id);
  const created = await runBatchForWorkspace(tenant.id, pending, db, (e) => events.push(e));

  expect(created).toBe(true);
  // step start/done pairs in order, then a terminal done with the update id
  const steps = events.filter((e) => e.type === "step");
  expect(steps.map((e) => `${(e as { key: string }).key}:${(e as { status: string }).status}`)).toEqual([
    "preparing:start", "preparing:done",
    "generating:start", "generating:done",
    "reviewing:start", "reviewing:done",
    "saving:start", "saving:done",
  ]);
  const done = events.at(-1);
  expect(done?.type).toBe("done");
  const [row] = await db.select().from(updates).where(eq(updates.tenantId, tenant.id));
  expect(done).toEqual({ type: "done", updateId: row.id });
});

it("runBatchForWorkspace emits an error event (not done) when generation fails twice", async () => {
  const { tenant, repoA } = await seed();
  await db.insert(changeItems).values({
    tenantId: tenant.id, repoId: repoA.id, sourceType: "pr", status: "pending", prNumber: 1, prTitle: "flaky",
  });
  vi.mocked(generateObject).mockRejectedValue(new Error("model unavailable"));

  const events: import("../../../src/lib/scheduling/draft-progress").DraftProgressEvent[] = [];
  const pending = await getPendingChangeItems(tenant.id);
  const created = await runBatchForWorkspace(tenant.id, pending, db, (e) => events.push(e));

  expect(created).toBe(false);
  expect(events.some((e) => e.type === "done")).toBe(false);
  const err = events.find((e) => e.type === "error");
  expect(err).toBeTruthy();
  expect((err as { message: string }).message).toContain("model unavailable");
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/scheduling/run-schedule.test.ts`
Expected: FAIL — `runBatchForWorkspace` doesn't accept a 4th arg / emits nothing.

- [ ] **Step 5: Emit progress from runBatchForWorkspace**

In `src/lib/scheduling/run-schedule.ts`, import the type and update the signature + body. Replace the current `runBatchForWorkspace` (lines ~23-89) so it threads `onProgress` and emits events. Keep the auto-publish block unchanged:

```ts
import type { OnDraftProgress } from "./draft-progress";
```

```ts
export async function runBatchForWorkspace(
  tenantId: string,
  pending: ChangeItemRow[],
  database: typeof defaultDb = defaultDb,
  onProgress?: OnDraftProgress
): Promise<boolean> {
  if (pending.length === 0) return false;

  onProgress?.({ type: "step", key: "preparing", status: "start" });
  const brandProfile = await getOrCreateBrandProfile(tenantId, database);
  const reposById = await reposByIdForTenant(tenantId, database);
  const catalog = await database.select().from(systemPersonas);
  const personas = resolvePersonaRefs(brandProfile.userPersonas, catalog);
  const allExamples = await database.select().from(systemUpdateExamples);
  const examples = selectExamples(allExamples, {
    industry: brandProfile.industry,
    personaKeys: systemPersonaKeys(brandProfile.userPersonas),
    categories: batchCategories(pending),
  });
  onProgress?.({ type: "step", key: "preparing", status: "done" });

  onProgress?.({ type: "step", key: "generating", status: "start" });
  let draft;
  try {
    draft = await generateUpdateDraft(pending, brandProfile, reposById, personas, examples);
  } catch {
    try {
      draft = await generateUpdateDraft(pending, brandProfile, reposById, personas, examples);
    } catch (err) {
      // Both attempts failed. Leave the batch's items pending — they roll into
      // the next scheduled/threshold/manual run automatically.
      onProgress?.({ type: "error", message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }
  onProgress?.({ type: "step", key: "generating", status: "done" });

  onProgress?.({ type: "step", key: "reviewing", status: "start" });
  const review = await reviewAndReconcile(draft, brandProfile, onProgress);
  onProgress?.({ type: "step", key: "reviewing", status: "done" });

  onProgress?.({ type: "step", key: "saving", status: "start" });
  const update = await claimBatchAndCreateUpdate(
    {
      tenantId,
      changeItemIds: pending.map((p) => p.id),
      draft: review.finalDraft,
      review: { status: review.status, issues: review.issues },
    },
    database
  );
  if (!update) {
    onProgress?.({ type: "error", message: "No changes were available to draft." });
    return false;
  }
  onProgress?.({ type: "step", key: "saving", status: "done" });

  // Auto-publish: only when the workspace opted in, an active webhook exists, AND
  // the review passed/revised — otherwise the update stays a draft for review.
  const [tenant] = await database.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const [activeWebhook] = await database
    .select()
    .from(webhookConfigs)
    .where(and(eq(webhookConfigs.tenantId, tenantId), eq(webhookConfigs.active, true)))
    .limit(1);

  const reviewPassed = review.status === "passed" || review.status === "revised";
  if (tenant?.autoPublish && activeWebhook && reviewPassed) {
    await database
      .update(updates)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(updates.id, update.id));
    await dispatchWebhookForUpdate(update.id, database);
  }

  onProgress?.({ type: "done", updateId: update.id });
  return true;
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run tests/lib/scheduling/run-schedule.test.ts && npm run typecheck`
Expected: all pass; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/scheduling/draft-progress.ts src/lib/ai/review-draft.ts src/lib/scheduling/run-schedule.ts tests/lib/scheduling/run-schedule.test.ts
git commit -m "feat: emit step-by-step progress from draft generation"
```

---

### Task 2: Streaming draft route

**Files:**
- Create: `src/app/api/pending/draft/route.ts`
- Test: `tests/app/api/pending/draft/route.test.ts`

**Interfaces:**
- Consumes: `runBatchForWorkspace(..., onProgress)`, `getBatchableChangeItems`, `getServerSession`/`hasValidSession`/`authOptions`, `DraftProgressEvent`.
- Produces: `POST` handler streaming NDJSON `DraftProgressEvent` lines; 401 when unauthenticated.

- [ ] **Step 1: Verify the patched Next.js route/stream APIs**

Read the relevant guide under `node_modules/next/dist/docs/` for route handlers and streaming responses, and confirm `getServerSession(authOptions)` works in a route handler (it's used the same way `requireSession` uses it in `src/lib/workspace/session.ts`). Note any deviation from stock before writing.

- [ ] **Step 2: Write the failing test**

Create `tests/app/api/pending/draft/route.test.ts`. Mock the session and the batch so the test is deterministic:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("../../../../../src/lib/scheduling/run-schedule", () => ({ runBatchForWorkspace: vi.fn() }));
vi.mock("../../../../../src/lib/change-items/change-item-batch", () => ({ getBatchableChangeItems: vi.fn() }));

import { getServerSession } from "next-auth";
import { runBatchForWorkspace } from "../../../../../src/lib/scheduling/run-schedule";
import { getBatchableChangeItems } from "../../../../../src/lib/change-items/change-item-batch";
import { POST } from "../../../../../src/app/api/pending/draft/route";

async function readNdjson(res: Response) {
  const text = await res.text();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  vi.mocked(getServerSession).mockReset();
  vi.mocked(runBatchForWorkspace).mockReset();
  vi.mocked(getBatchableChangeItems).mockReset();
});

describe("POST /api/pending/draft", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getServerSession).mockResolvedValue(null as never);
    const res = await POST(new Request("http://x/api/pending/draft", { method: "POST" }));
    expect(res.status).toBe(401);
  });

  it("streams collecting + an error event when there are no pending changes", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: "t1" } } as never);
    vi.mocked(getBatchableChangeItems).mockResolvedValue([] as never);
    const res = await POST(new Request("http://x/api/pending/draft", { method: "POST" }));
    const events = await readNdjson(res);
    expect(events).toContainEqual({ type: "step", key: "collecting", status: "start" });
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(runBatchForWorkspace).not.toHaveBeenCalled();
  });

  it("forwards runBatchForWorkspace progress events to the stream", async () => {
    vi.mocked(getServerSession).mockResolvedValue({ user: { tenantId: "t1" } } as never);
    vi.mocked(getBatchableChangeItems).mockResolvedValue([{ id: "c1" }] as never);
    vi.mocked(runBatchForWorkspace).mockImplementation(async (_t, _p, _db, onProgress) => {
      onProgress?.({ type: "step", key: "generating", status: "start" });
      onProgress?.({ type: "done", updateId: "u1" });
      return true;
    });
    const res = await POST(new Request("http://x/api/pending/draft", { method: "POST" }));
    const events = await readNdjson(res);
    expect(events).toContainEqual({ type: "step", key: "collecting", status: "done" });
    expect(events).toContainEqual({ type: "step", key: "generating", status: "start" });
    expect(events.at(-1)).toEqual({ type: "done", updateId: "u1" });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/app/api/pending/draft/route.test.ts`
Expected: FAIL — the route module doesn't exist.

- [ ] **Step 4: Implement the route**

Create `src/app/api/pending/draft/route.ts`:

```ts
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/workspace/auth";
import { hasValidSession } from "@/lib/workspace/session";
import { db } from "@/db";
import { getBatchableChangeItems } from "@/lib/change-items/change-item-batch";
import { runBatchForWorkspace } from "@/lib/scheduling/run-schedule";
import type { DraftProgressEvent } from "@/lib/scheduling/draft-progress";

export async function POST(_req: Request): Promise<Response> {
  const session = await getServerSession(authOptions);
  if (!hasValidSession(session)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  const tenantId = session.user.tenantId;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: DraftProgressEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        emit({ type: "step", key: "collecting", status: "start" });
        const pending = await getBatchableChangeItems(tenantId, db);
        if (pending.length === 0) {
          emit({ type: "error", message: "No pending changes to draft." });
          return;
        }
        emit({ type: "step", key: "collecting", status: "done" });
        await runBatchForWorkspace(tenantId, pending, db, emit);
      } catch (err) {
        emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
```

(Confirm the auth module path — `authOptions` is imported by `src/lib/workspace/session.ts` from `./auth`, i.e. `@/lib/workspace/auth`.)

- [ ] **Step 5: Run the test + typecheck**

Run: `npx vitest run tests/app/api/pending/draft/route.test.ts && npm run typecheck`
Expected: all pass; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/pending/draft/route.ts tests/app/api/pending/draft/route.test.ts
git commit -m "feat: streaming NDJSON route for draft creation progress"
```

---

### Task 3: Modal component + pending page wiring

**Files:**
- Create: `src/app/(dashboard)/pending/draft-update-dialog.tsx`
- Modify: `src/app/(dashboard)/pending/page.tsx`

**Interfaces:**
- Consumes: `DRAFT_STEPS`, `DraftProgressEvent` (draft-progress.ts); `POST /api/pending/draft`; `getBatchableChangeItems`.
- Produces: `<DraftUpdateDialog preview={{ count, earliest, latest }} />` replacing the footer draft button.

- [ ] **Step 1: Build the modal component**

Create `src/app/(dashboard)/pending/draft-update-dialog.tsx`. Follow the Dialog pattern already used in `src/app/(dashboard)/pending/import-commits-dialog.tsx` (imports from `@/components/ui/dialog`: `Dialog`, `DialogTrigger`, `DialogContent`, `DialogHeader`, `DialogTitle`; controlled `open` + `onOpenChange`). Full component:

```tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, Check, Circle, AlertCircle } from "lucide-react";
import { DRAFT_STEPS, type DraftProgressEvent, type DraftStepKey } from "@/lib/scheduling/draft-progress";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type Phase = "preview" | "progress" | "error" | "success";
type StepStatus = "pending" | "active" | "done";

export function DraftUpdateDialog({
  preview,
}: {
  preview: { count: number; earliest: string | null; latest: string | null };
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("preview");
  const [statuses, setStatuses] = useState<Record<DraftStepKey, StepStatus>>(initialStatuses());
  const [detail, setDetail] = useState("");
  const [error, setError] = useState("");
  const [updateId, setUpdateId] = useState<string | null>(null);

  function reset() {
    setPhase("preview");
    setStatuses(initialStatuses());
    setDetail("");
    setError("");
    setUpdateId(null);
  }

  function apply(event: DraftProgressEvent) {
    if (event.type === "step") {
      setStatuses((s) => ({ ...s, [event.key]: event.status === "start" ? "active" : "done" }));
      if (event.status === "start") setDetail("");
    } else if (event.type === "detail") {
      setDetail(event.text);
    } else if (event.type === "done") {
      setUpdateId(event.updateId);
      setPhase("success");
    } else if (event.type === "error") {
      setError(event.message);
      setPhase("error");
    }
  }

  async function create() {
    reset();
    setPhase("progress");
    try {
      const res = await fetch("/api/pending/draft", { method: "POST" });
      if (!res.ok || !res.body) {
        setError(res.status === 401 ? "Your session expired — please sign in again." : "Failed to start draft creation.");
        setPhase("error");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) apply(JSON.parse(line) as DraftProgressEvent);
        }
      }
      if (buffer.trim()) apply(JSON.parse(buffer) as DraftProgressEvent);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }

  const range =
    preview.earliest && preview.latest
      ? `${fmt(preview.earliest)} → ${fmt(preview.latest)}`
      : "no dated changes";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button>Draft update now</Button>} />
      <DialogContent className="flex flex-col gap-5 p-6 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Draft update</DialogTitle>
        </DialogHeader>

        {phase === "preview" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This draft will include <span className="font-medium text-foreground">{preview.count}</span>{" "}
              change{preview.count === 1 ? "" : "s"} ({range}).
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={create} disabled={preview.count === 0}>Create draft</Button>
            </div>
          </div>
        )}

        {phase === "progress" && (
          <ol className="space-y-2">
            {DRAFT_STEPS.map((step) => {
              const st = statuses[step.key];
              return (
                <li key={step.key} className="flex items-center gap-2 text-sm">
                  {st === "done" ? (
                    <Check className="size-4 text-emerald-600" />
                  ) : st === "active" ? (
                    <Loader2 className="size-4 animate-spin text-foreground" />
                  ) : (
                    <Circle className="size-4 text-muted-foreground/40" />
                  )}
                  <span className={st === "pending" ? "text-muted-foreground" : "text-foreground"}>
                    {step.label}
                  </span>
                  {st === "active" && detail && (
                    <span className="text-xs text-muted-foreground">· {detail}</span>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {phase === "error" && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p className="break-words text-destructive">{error}</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
              <Button onClick={create}>Try again</Button>
            </div>
          </div>
        )}

        {phase === "success" && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-emerald-600">
              <Check className="size-4" /> Draft created.
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
              {updateId && <Button render={<Link href={`/drafts/${updateId}`} />}>Review it</Button>}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function initialStatuses(): Record<DraftStepKey, StepStatus> {
  return DRAFT_STEPS.reduce(
    (acc, s) => ({ ...acc, [s.key]: "pending" }),
    {} as Record<DraftStepKey, StepStatus>
  );
}

function fmt(iso: string): string {
  return new Date(iso).toLocaleDateString();
}
```

(If `DialogHeader`/`DialogTitle` import names differ, match whatever `import-commits-dialog.tsx` imports.)

- [ ] **Step 2: Compute preview + wire the dialog into the pending page**

In `src/app/(dashboard)/pending/page.tsx`:

1. Add imports:
```tsx
import { getBatchableChangeItems } from "@/lib/change-items/change-item-batch";
import { DraftUpdateDialog } from "./draft-update-dialog";
```
2. Remove `runNow` from the `./actions` import (leave `dropChangeItem`, `includeChangeItem`).
3. After `const tracked = await getTrackedChangeItems(...)` (and its sort), compute the preview:
```tsx
const batchable = await getBatchableChangeItems(session.user.tenantId);
const batchableWhens = batchable
  .map((b) => (b.sourceType === "pr" ? b.mergedAt : b.committedAt))
  .filter((d): d is Date => d instanceof Date)
  .sort((a, b) => a.getTime() - b.getTime());
const draftPreview = {
  count: batchable.length,
  earliest: batchableWhens[0]?.toISOString() ?? null,
  latest: batchableWhens.at(-1)?.toISOString() ?? null,
};
```
4. Replace the footer form:
```tsx
                  <form action={runNow}>
                    <Button type="submit">Draft update now</Button>
                  </form>
```
with:
```tsx
                  <DraftUpdateDialog preview={draftPreview} />
```

- [ ] **Step 3: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 4: Manual smoke check**

Interactive (controller/human): with pending changes present, open the Pending page, click **Draft update now** → the modal shows the preview count + date range → **Create draft** streams the steps → ends in **Draft created** with a **Review it** link to `/drafts/{id}`. (A subagent should statically confirm the component wiring and note that interactive smoke is deferred.)

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/pending/draft-update-dialog.tsx" "src/app/(dashboard)/pending/page.tsx"
git commit -m "feat: draft-creation modal with streamed progress on the Pending page"
```

---

### Task 4: Remove the replaced flow (dead code)

**Files:**
- Modify: `src/app/(dashboard)/pending/actions.ts` (remove `runNow`, `chooseSchedule`)
- Modify: `src/lib/scheduling/run-schedule.ts` (remove `applyPostRunScheduleChoice`)
- Delete: `src/app/(dashboard)/pending/schedule-choice/page.tsx` (and the now-empty `schedule-choice/` dir)
- Modify: `tests/lib/scheduling/run-schedule.test.ts` (remove the `applyPostRunScheduleChoice` test)

**Interfaces:**
- Consumes: nothing new. This removes now-unreferenced code (Task 3 stopped using `runNow`).

- [ ] **Step 1: Confirm nothing still references the symbols**

Run: `grep -rn "runNow\|chooseSchedule\|applyPostRunScheduleChoice\|schedule-choice" src tests`
Expected: the only hits are the definitions/test being removed and imports in the files listed above. (If anything else references them, stop and report.)

- [ ] **Step 2: Delete `runNow` and `chooseSchedule`**

In `src/app/(dashboard)/pending/actions.ts`: delete the `runNow` function (the `export async function runNow() { ... redirect("/pending/schedule-choice"); }` block) and the `chooseSchedule` function. Then remove now-unused imports: `applyPostRunScheduleChoice` from the `@/lib/scheduling/run-schedule` import, and `redirect` from `next/navigation` **only if** no other function in the file still uses it (check first — `addRepo`/others may not; if unused, remove it). Leave `runBatchForWorkspace` out of the import too if nothing else in the file uses it (it was only used by `runNow`).

- [ ] **Step 3: Delete `applyPostRunScheduleChoice`**

In `src/lib/scheduling/run-schedule.ts`: delete the `applyPostRunScheduleChoice` function. Keep `advanceNextScheduledAt` imported (still used by `runSchedulerTick`).

- [ ] **Step 4: Delete the schedule-choice page + test**

```bash
rm src/app/\(dashboard\)/pending/schedule-choice/page.tsx
rmdir src/app/\(dashboard\)/pending/schedule-choice
```
In `tests/lib/scheduling/run-schedule.test.ts`: remove the `applyPostRunScheduleChoice` import from the top-of-file import and delete the test `it("applyPostRunScheduleChoice('skip') advances the workspace schedule from its current value", ...)`.

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean (no dangling references); all tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove the runNow / schedule-choice flow replaced by the draft modal"
```

---

## Self-Review Notes

- **Spec coverage:** preview (Task 3 Step 1-2), streamed progress (Task 1 + Task 2 + Task 3 stream reader), error inline (error events → error phase), success + review link (done event → success phase, `/drafts/{updateId}`), schedule choice removed (Task 4). All spec sections mapped.
- **Type consistency:** `DraftProgressEvent` / `DraftStepKey` / `DRAFT_STEPS` defined once in draft-progress.ts and consumed identically in run-schedule.ts, review-draft.ts, the route, and the modal. `runBatchForWorkspace` returns `boolean` throughout; `onProgress` is the trailing optional arg everywhere.
- **Ordering:** Task 1 defines the contract before Task 2/3 consume it; Task 3 stops using `runNow` before Task 4 deletes it, so every intermediate state builds.
