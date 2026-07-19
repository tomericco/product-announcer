# Threshold trigger toggle

## Problem

The scheduler generates a draft update on **either** of two independent triggers
(`shouldTriggerRun` in `src/lib/scheduling/scheduler-decision.ts`):

1. **Cadence** — the scheduled publish time (`nextScheduledAt`) has arrived.
2. **Threshold** — `pendingCount >= threshold` (when `threshold > 0`).

The threshold fires regardless of the scheduled time. A bulk import of many
commits instantly exceeds a small threshold and produces a surprise draft well
before the intended cadence date. There is currently no way to keep a threshold
value configured while turning the trigger off — the only "off" is clearing the
number, which loses the value.

## Goal

Make the threshold trigger **optional behind an explicit toggle**, independent of
the threshold value, and **off by default (opt-in)** — including for existing
schedules. The cadence trigger is unchanged.

## Design

### 1. Data model

Add to `schedule_configs` (`src/db/schema.ts`):

```
thresholdEnabled: boolean("threshold_enabled").notNull().default(false)
```

Drizzle migration; existing rows backfill to `false` via the default. The
threshold *number* stays stored, so toggling on later restores the prior value.

### 2. Decision logic (the only behavior change)

`src/lib/scheduling/scheduler-decision.ts`:

- `ScheduleState` gains `thresholdEnabled: boolean`.
- The threshold branch of `shouldTriggerRun` becomes:
  `state.thresholdEnabled && state.threshold !== null && state.threshold > 0 && state.pendingCount >= state.threshold`.
- The cadence branch is untouched and still takes precedence.

### 3. Scheduler caller

`src/lib/scheduling/run-schedule.ts` (`runSchedulerTick`) builds the
`ScheduleState` from the config row — add `thresholdEnabled: config.thresholdEnabled`.

### 4. Settings UI

`src/app/(dashboard)/settings/schedule-form.tsx`:

- Add a `Switch` (`name="thresholdEnabled"`) labeled *"Publish early when changes
  pile up"* directly above the existing Threshold field.
- Track its state with `useState(defaults.thresholdEnabled)`; when off, the
  threshold number `Input` is **disabled** (greyed) so the dependency is visible.
- Defaults sourced from `defaults.thresholdEnabled`.

### 5. Persistence

- `saveWorkspaceSchedule` (`src/app/(dashboard)/settings/actions.ts`): read
  `formData.get("thresholdEnabled") === "on"` and persist it alongside the other
  schedule fields (in both the insert values and the `onConflictDoUpdate` set).
- `src/app/(dashboard)/settings/page.tsx`: pass
  `thresholdEnabled: workspaceSchedule?.thresholdEnabled ?? false` into the
  `ScheduleForm` defaults.
- `src/app/onboarding/actions.ts`: set `thresholdEnabled: false` on the initial
  config insert (opt-in default; onboarding does not surface the toggle).

### 6. Tests

`tests/lib/scheduling/scheduler-decision.test.ts` (extend existing):

- Threshold does **not** fire when `thresholdEnabled: false` even if
  `pendingCount >= threshold` → returns `null`.
- Threshold **does** fire when `thresholdEnabled: true` and
  `pendingCount >= threshold` → returns `"threshold"`.
- Cadence still fires regardless of `thresholdEnabled`.

## Out of scope (YAGNI)

- No per-run override.
- No UI to view or undo drafts already batched (the separate "discard draft"
  idea — reverting `batched → pending` — is not part of this).
