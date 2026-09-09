# Plan: add `xs` and `xxs` size bands and keep them out of shipped-work signals

Bounded change, approved in chat 2026-09-09. No spec file; this plan is the authority.

## Goal

`shipped_work` signals track updates too small to write about. Add two bands
below `s` with crisp rules, so the resolver has a home for noise, and exclude
those bands in the reconciler so they never become signals.

## Global Constraints

- One source of truth for sizes: a new `src/lib/atomic-updates/sizes.ts`. Every
  literal `"s" | "m" | "l" | "xl"` union and `z.enum([...])` in the codebase is
  replaced by types/values derived from it. No hardcoded size lists remain
  outside that module and the pg enum in `schema.ts`.
- Band order and glosses (descending significance, EXACTLY these strings):
  1. `xl` — `a flagship or headline change — a major new capability or overhaul you would lead an announcement with`
  2. `l` — `a significant feature or major improvement worth calling out to many users`
  3. `m` — `a standard improvement or small feature noticeable to users of that area`
  4. `s` — `a minor fix, tweak, or polish that a user of that spot would notice and welcome — worth one line in a smaller-fixes list`
  5. `xs` — `a negligible user-facing change — a single copy or wording tweak, a pixel-level visual nudge, or a fix for an edge case almost nobody hits; not worth its own line`
  6. `xxs` — `nothing any user could notice — an internal refactor, dependency or tooling bump, test or CI change, logging, code comments, or a typo in code`
- Each band carries `signal: boolean`: `true` for xl/l/m/s, `false` for xs/xxs.
  `SIZES_BELOW_SIGNAL_FLOOR` is derived from that flag (never a second literal list).
- `SIZE_RUBRIC` text: the existing sentence (bands rendered ascending, i.e.
  xxs first, xl last) followed by exactly this sentence:
  `Decide from the bottom up: if no user could notice it, 'xxs'; if a user could notice it but would not care, 'xs'; otherwise 's' or larger by how many users it reaches and how much it changes for them.`
- Composer `SIZE_GUIDANCE` (compose-prompt.ts): the S sentence becomes
  `S, XS and XXS updates are minor: when there are two or more, gather them into a single bulleted list (e.g. under "Also improved" or "Smaller fixes") rather than a paragraph each; a lone one may be a brief one-liner.`
  Everything else in that string unchanged.
- xs/xxs updates remain visible on the Company page (badge, select, filter). Only the signal reconciler excludes them.
- Null size keeps today's behaviour everywhere (treated as `m` by the composer; included by the reconciler).
- Tests run against the `_test` database: after generating the migration run `npm run db:migrate:test`. Do NOT run `npm run db:migrate` (dev DB) — the owner runs that.
- The test suite is flaky under one shared Postgres: run a failing file a second time before treating it as broken, and only fix failures in files this change touches.

## Task 1: sizes module, bands, rubric, migration, consumers

Files:
- create `src/lib/atomic-updates/sizes.ts`: `SIZE_BANDS` (with `key`, `gloss`, `signal`), `SizeKey`, `SIZE_KEYS` (a non-empty tuple usable by `z.enum`, descending order), `SIZE_RANK`, `SIZES_BELOW_SIGNAL_FLOOR`. Carry over the "order is load-bearing" comment from prompt-rules.ts.
- `src/lib/ai/prompt-rules.ts`: remove `SIZE_BANDS`/`SizeKey`/`SIZE_RANK`; import from sizes.ts; keep `SIZE_RUBRIC` here, rendered from `SIZE_BANDS` reversed, plus the bottom-up sentence. Drop the "byte-identical" comment — it no longer holds.
- `src/db/schema.ts`: `atomicUpdateSizeEnum` values become `[...SIZE_KEYS]` (or the literal six if drizzle's `pgEnum` typing needs a literal tuple — then add a comment pointing at sizes.ts as the source of truth).
- `npm run db:generate` → new migration must contain `ALTER TYPE ... "atomic_update_size" ADD VALUE 'xs'` and `... 'xxs'` (position clauses are fine either way). Then `npm run db:migrate:test`.
- Replace literal unions/enums with `SizeKey` / `z.enum(SIZE_KEYS)` in: `src/lib/ai/resolve-atomic-updates.ts`, `src/lib/ai/regenerate-atomic-summary.ts`, `src/lib/atomic-updates/list.ts` (both spots), `src/app/(dashboard)/company/atomic-updates-actions.ts`, `src/app/(dashboard)/signals/evidence-actions.ts`, `src/app/(dashboard)/company/atomic-update-card.tsx` (`SIZE_OPTIONS`, cast), `src/app/(dashboard)/signals/evidence-drawer.tsx` (`SIZE_OPTIONS`), `src/lib/ai/compose-prompt.ts` (type + `SIZE_GUIDANCE`), `src/app/(dashboard)/company/filter-params.ts` (`ATOMIC_UPDATE_SIZES = ["all", ...SIZE_KEYS]` — check `readOption` still narrows), `src/app/(dashboard)/company/atomic-updates-filters.tsx` (`SIZE_OPTIONS` built from `SIZE_KEYS`, label = key uppercased). Select menus list sizes ascending (xxs → xl) so the visual order matches significance.
- Tests: `tests/lib/ai/prompt-rules.test.ts` — replace the byte-identical snapshot with: rubric names every band as `'key' (gloss)` in ascending order, and ends with the bottom-up sentence; `SIZE_RANK` strictly descending over `SIZE_BANDS`; add `tests/lib/atomic-updates/sizes.test.ts`: `SIZES_BELOW_SIGNAL_FLOOR` equals `["xs","xxs"]` and every other band has `signal: true`. Update any compose-prompt / template / filter-params tests that assert the old strings or lists.
- `npm run typecheck && npm run lint`, then `npx vitest run tests/lib/ai tests/lib/atomic-updates tests/app/company-filter-params.test.ts`.

## Task 2: reconciler excludes sub-floor sizes

Files:
- `src/lib/signals/shipped-work.ts`: candidate `where` adds `or(isNull(atomicUpdates.size), notInArray(atomicUpdates.size, SIZES_BELOW_SIGNAL_FLOOR))`. Extend the doc comment: re-sizing an update below the floor drops it from `visible`, so the existing stale-marking flips its signal to `stale`; re-sizing it back up re-upserts and flips it to `new` — same mechanics as hide/unhide, nothing new to write.
- `tests/lib/signals/shipped-work.test.ts`, following the file's existing fixtures:
  1. `xs` and `xxs` atomic updates produce no signal; an `s` sibling in the same tenant does.
  2. An update with `size: null` still produces a signal.
  3. An update that already has a `new` signal, once set to `xs`, has that signal marked `stale` on the next sync (row count unchanged); set back to `m`, it returns to `new`.
- `npx vitest run tests/lib/signals/shipped-work.test.ts`, `npm run typecheck`, `npm run lint`.
