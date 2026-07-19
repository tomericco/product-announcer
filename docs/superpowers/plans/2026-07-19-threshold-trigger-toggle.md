# Threshold Trigger Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the scheduler's threshold trigger optional behind an explicit, off-by-default toggle, independent of the threshold number.

**Architecture:** Add a `thresholdEnabled` boolean to `schedule_configs` (default false). Gate the threshold branch of `shouldTriggerRun` on it. Surface a switch in the Settings schedule form and persist it. The cadence trigger is unchanged.

**Tech Stack:** Next.js (App Router, server actions), Drizzle ORM + Postgres, Vitest, Base UI (`Switch`).

## Global Constraints

- Off by default (opt-in): the new column is `NOT NULL DEFAULT false`; existing rows backfill to `false`. New workspaces start disabled.
- The threshold *number* stays stored regardless of the toggle, so re-enabling restores the prior value.
- Only the threshold trigger is gated; the cadence trigger's behavior is unchanged.
- This is Next.js with breaking changes from stock — do not assume stock App Router APIs; follow existing patterns in the files being edited.

---

### Task 1: Add `thresholdEnabled` column + migration

**Files:**
- Modify: `src/db/schema.ts` (the `scheduleConfigs` table, after the `threshold` column ~line 116)
- Create (generated): `src/db/migrations/*` (drizzle-kit output)

**Interfaces:**
- Produces: `scheduleConfigs.thresholdEnabled` — a `boolean` column, non-null, default `false`. `typeof scheduleConfigs.$inferSelect` now includes `thresholdEnabled: boolean`.

- [ ] **Step 1: Add the column to the schema**

In `src/db/schema.ts`, inside `export const scheduleConfigs = pgTable("schedule_configs", { ... })`, add a line immediately after `threshold: integer("threshold"),`:

```typescript
  threshold: integer("threshold"),
  // Whether the threshold trigger is active. Off by default so a bulk import
  // doesn't auto-generate a draft ahead of the scheduled cadence; the threshold
  // number above is retained regardless, so re-enabling restores it.
  thresholdEnabled: boolean("threshold_enabled").notNull().default(false),
```

(`boolean` is already imported at the top of the file.)

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new SQL migration appears under `src/db/migrations/` adding `threshold_enabled boolean not null default false` to `schedule_configs`.

- [ ] **Step 3: Apply the migration**

Run: `npm run db:migrate`
Expected: migration applies with no error against the local Postgres.

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors (adding a column with a default breaks nothing existing).

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/migrations
git commit -m "feat: add threshold_enabled column to schedule_configs (default off)"
```

---

### Task 2: Gate the threshold trigger on `thresholdEnabled`

**Files:**
- Modify: `src/lib/scheduling/scheduler-decision.ts` (the `ScheduleState` type and `shouldTriggerRun`)
- Modify: `src/lib/scheduling/run-schedule.ts` (the `ScheduleState` built in `runSchedulerTick`, ~lines 98-105)
- Test: `tests/lib/scheduling/scheduler-decision.test.ts`

**Interfaces:**
- Consumes: `scheduleConfigs.thresholdEnabled` from Task 1.
- Produces: `ScheduleState` gains a required `thresholdEnabled: boolean`. `shouldTriggerRun(state, now)` returns `"threshold"` only when `thresholdEnabled` is true (and `threshold > 0` and `pendingCount >= threshold`).

- [ ] **Step 1: Update and extend the tests**

In `tests/lib/scheduling/scheduler-decision.test.ts`, every `ScheduleState` literal in the `describe("shouldTriggerRun", ...)` block needs the new field. Replace the existing `shouldTriggerRun` describe block (lines 8-58) with:

```typescript
describe("shouldTriggerRun", () => {
  const now = new Date("2026-07-13T12:00:00Z");

  it("returns null when there is nothing pending, even if the cadence deadline passed", () => {
    const result = shouldTriggerRun(
      { cadence: "weekly", nextScheduledAt: new Date("2026-07-01T00:00:00Z"), threshold: 5, thresholdEnabled: true, pendingCount: 0 },
      now
    );
    expect(result).toBeNull();
  });

  it("returns 'cadence' when the deadline has passed and something is pending", () => {
    const result = shouldTriggerRun(
      { cadence: "weekly", nextScheduledAt: new Date("2026-07-01T00:00:00Z"), threshold: 5, thresholdEnabled: false, pendingCount: 1 },
      now
    );
    expect(result).toBe("cadence");
  });

  it("returns null when the cadence deadline has not passed and the threshold isn't met", () => {
    const result = shouldTriggerRun(
      { cadence: "weekly", nextScheduledAt: new Date("2026-07-20T00:00:00Z"), threshold: 5, thresholdEnabled: true, pendingCount: 2 },
      now
    );
    expect(result).toBeNull();
  });

  it("returns 'threshold' when enabled and the pending count meets it, even before the cadence deadline", () => {
    const result = shouldTriggerRun(
      { cadence: "weekly", nextScheduledAt: new Date("2026-07-20T00:00:00Z"), threshold: 5, thresholdEnabled: true, pendingCount: 5 },
      now
    );
    expect(result).toBe("threshold");
  });

  it("does NOT fire the threshold when disabled, even if the pending count meets it", () => {
    const result = shouldTriggerRun(
      { cadence: "weekly", nextScheduledAt: new Date("2026-07-20T00:00:00Z"), threshold: 5, thresholdEnabled: false, pendingCount: 999 },
      now
    );
    expect(result).toBeNull();
  });

  it("still fires the cadence regardless of the threshold toggle being off", () => {
    const result = shouldTriggerRun(
      { cadence: "weekly", nextScheduledAt: new Date("2026-07-01T00:00:00Z"), threshold: 5, thresholdEnabled: false, pendingCount: 1 },
      now
    );
    expect(result).toBe("cadence");
  });

  it("ignores nextScheduledAt entirely when cadence is 'none'", () => {
    const result = shouldTriggerRun(
      { cadence: "none", nextScheduledAt: new Date("2026-01-01T00:00:00Z"), threshold: 5, thresholdEnabled: true, pendingCount: 3 },
      now
    );
    expect(result).toBeNull();
  });

  it("treats a null/zero threshold as disabled even when the toggle is on", () => {
    const result = shouldTriggerRun(
      { cadence: "weekly", nextScheduledAt: new Date("2026-07-20T00:00:00Z"), threshold: null, thresholdEnabled: true, pendingCount: 999 },
      now
    );
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/scheduling/scheduler-decision.test.ts`
Expected: FAIL — TypeScript error that `thresholdEnabled` is not a property of `ScheduleState` (the type doesn't have it yet).

- [ ] **Step 3: Add the field to `ScheduleState` and gate the branch**

In `src/lib/scheduling/scheduler-decision.ts`, update the `ScheduleState` type and `shouldTriggerRun`:

```typescript
export type ScheduleState = {
  cadence: Cadence;
  nextScheduledAt: Date | null;
  threshold: number | null;
  thresholdEnabled: boolean;
  pendingCount: number;
};

export type TriggerReason = "cadence" | "threshold";

export function shouldTriggerRun(state: ScheduleState, now: Date): TriggerReason | null {
  if (state.pendingCount === 0) return null;

  const cadenceDue =
    state.cadence !== "none" && state.nextScheduledAt !== null && now.getTime() >= state.nextScheduledAt.getTime();
  if (cadenceDue) return "cadence";

  const thresholdMet =
    state.thresholdEnabled &&
    state.threshold !== null &&
    state.threshold > 0 &&
    state.pendingCount >= state.threshold;
  if (thresholdMet) return "threshold";

  return null;
}
```

- [ ] **Step 4: Pass the field through in the scheduler tick**

In `src/lib/scheduling/run-schedule.ts`, inside `runSchedulerTick`, the object passed to `shouldTriggerRun` currently is:

```typescript
      const reason = shouldTriggerRun(
        {
          cadence: config.cadence,
          nextScheduledAt: config.nextScheduledAt,
          threshold: config.threshold,
          pendingCount: pending.length,
        },
        now
      );
```

Add the `thresholdEnabled` line:

```typescript
      const reason = shouldTriggerRun(
        {
          cadence: config.cadence,
          nextScheduledAt: config.nextScheduledAt,
          threshold: config.threshold,
          thresholdEnabled: config.thresholdEnabled,
          pendingCount: pending.length,
        },
        now
      );
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run tests/lib/scheduling/scheduler-decision.test.ts && npm run typecheck`
Expected: all scheduler-decision tests PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/scheduling/scheduler-decision.ts src/lib/scheduling/run-schedule.ts tests/lib/scheduling/scheduler-decision.test.ts
git commit -m "feat: gate the threshold trigger on schedule.thresholdEnabled"
```

---

### Task 3: Settings toggle + persistence

**Files:**
- Modify: `src/app/(dashboard)/settings/schedule-form.tsx` (add the switch, disable the threshold input when off)
- Modify: `src/app/(dashboard)/settings/actions.ts` (`saveWorkspaceSchedule` — read + persist `thresholdEnabled`)
- Modify: `src/app/(dashboard)/settings/page.tsx` (pass `thresholdEnabled` into the form defaults)
- Modify: `src/app/onboarding/actions.ts` (`saveOnboardingSchedule` — set `thresholdEnabled: false` on insert)

**Interfaces:**
- Consumes: `scheduleConfigs.thresholdEnabled` (Task 1); the gated `shouldTriggerRun` (Task 2).
- Produces: the Settings schedule form exposes a `thresholdEnabled` switch (form field name `"thresholdEnabled"`); `saveWorkspaceSchedule` persists it.

- [ ] **Step 1: Add the switch to the schedule form**

In `src/app/(dashboard)/settings/schedule-form.tsx`:

Add `Switch` to the imports:

```typescript
import { Switch } from "@/components/ui/switch";
```

Extend the `defaults` prop type to include the flag:

```typescript
  defaults: {
    cadence: string;
    threshold: number | null;
    thresholdEnabled: boolean;
    hour: number;
    dayOfWeek: number | null;
    dayOfMonth: number | null;
  };
```

Add controlled state near the other `useState` calls (after `dayOfMonth`):

```typescript
  const [thresholdEnabled, setThresholdEnabled] = useState(defaults.thresholdEnabled);
```

Replace the existing Threshold block (the `<div className="space-y-2">` containing the Threshold `Label`, helper `<p>`, and `Input`) with:

```tsx
      <div className="space-y-2">
        <label className="flex items-center gap-3 text-sm font-medium">
          <Switch
            name="thresholdEnabled"
            checked={thresholdEnabled}
            onCheckedChange={(checked) => setThresholdEnabled(checked as boolean)}
          />
          Publish early when changes pile up
        </label>
        <p className="text-xs text-muted-foreground">
          When on, generate an update as soon as at least this many changes are pending, without
          waiting for the next scheduled run.
        </p>
        <Input
          id="threshold"
          type="number"
          name="threshold"
          min={1}
          defaultValue={defaults.threshold ?? 5}
          disabled={!thresholdEnabled}
        />
      </div>
```

(Confirm the `Switch` component's callback prop is `onCheckedChange` — it is the same `Switch` already used in `settings/page.tsx`'s auto-publish card. If that card uses a different prop, match it.)

- [ ] **Step 2: Persist the flag in the save action**

In `src/app/(dashboard)/settings/actions.ts`, inside `saveWorkspaceSchedule`, read the checkbox and add it to the persisted values. After the line `const hour = Math.min(23, ...);` add:

```typescript
  const thresholdEnabled = formData.get("thresholdEnabled") === "on";
```

Then include it in the `values` object:

```typescript
  const values = { cadence, threshold, thresholdEnabled, hour, dayOfWeek, dayOfMonth, nextScheduledAt };
```

(`values` is used for both the insert and the `onConflictDoUpdate` set, so this covers both paths.)

- [ ] **Step 3: Pass the default into the form**

In `src/app/(dashboard)/settings/page.tsx`, the `<ScheduleForm defaults={{ ... }} />` currently passes `cadence`, `threshold`, `hour`, `dayOfWeek`, `dayOfMonth`. Add `thresholdEnabled`:

```tsx
          <ScheduleForm
            defaults={{
              cadence: workspaceSchedule?.cadence ?? "weekly",
              threshold: workspaceSchedule?.threshold ?? null,
              thresholdEnabled: workspaceSchedule?.thresholdEnabled ?? false,
              hour: workspaceSchedule?.hour ?? 9,
              dayOfWeek: workspaceSchedule?.dayOfWeek ?? null,
              dayOfMonth: workspaceSchedule?.dayOfMonth ?? null,
            }}
          />
```

- [ ] **Step 4: Default the flag off in onboarding**

In `src/app/onboarding/actions.ts`, `saveOnboardingSchedule` inserts a config. Set `thresholdEnabled: false` explicitly on the insert values (the column default also covers it, but be explicit):

```typescript
  await db
    .insert(scheduleConfigs)
    .values({ tenantId: session.user.tenantId, cadence, threshold, thresholdEnabled: false, nextScheduledAt })
    .onConflictDoUpdate({
      target: scheduleConfigs.tenantId,
      set: { cadence, threshold, nextScheduledAt },
    });
```

(Leave the `onConflictDoUpdate` set as-is — onboarding should not flip an existing workspace's toggle.)

- [ ] **Step 5: Typecheck and run the full test suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests pass.

- [ ] **Step 6: Manual smoke check**

Run the dev server, open Settings → Publishing schedule. Confirm: the switch defaults off; the threshold number input is greyed/disabled while off; toggling on enables it; Save persists (reload keeps the state).

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/settings/schedule-form.tsx" "src/app/(dashboard)/settings/actions.ts" "src/app/(dashboard)/settings/page.tsx" "src/app/onboarding/actions.ts"
git commit -m "feat: expose threshold-trigger toggle in the Settings schedule form"
```

---

## Self-Review Notes

- **Spec coverage:** data model (Task 1), decision logic (Task 2), scheduler caller (Task 2 Step 4), settings UI (Task 3 Steps 1), persistence — save action / page default / onboarding (Task 3 Steps 2-4), tests (Task 2 Step 1). All spec sections mapped.
- **Type consistency:** `thresholdEnabled: boolean` is used identically in the schema column, `ScheduleState`, the `ScheduleForm` `defaults` prop, and the form field name `"thresholdEnabled"`.
- **Ordering:** Task 1 adds the column before Task 2 reads it in `run-schedule.ts`; every intermediate state builds.
