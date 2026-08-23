import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { SETTLED_RUN_STATUSES } from "@/lib/ai-visibility/metrics";

/**
 * `SETTLED_RUN_STATUSES` is meant to be the ONE answer to "which runs' data is
 * admitted". It keeps not being: `cited-domains.ts` and `signals.ts` each
 * carried their own `eq(aiVisibilityRuns.status, "complete")`, so the tiles,
 * the trend chart and the benchmark counted a cap-paused run's answers while
 * the cited-domains leaderboard and the two "first ever" triggers silently did
 * not. The tenant paid for those samples on both sides of that line.
 *
 * No behavioural test catches the NEXT copy of it — a new window over runs
 * looks correct in isolation and only disagrees with the rest of the page —
 * so this reads the source instead, in the spirit of
 * `tests/app/client-module-boundary.test.ts`.
 *
 * Deliberately narrow, so it fails on the mistake and on nothing else. It
 * matches only a status COMPARISON against a `"complete"` literal:
 *
 *   eq(aiVisibilityRuns.status, "complete")
 *   inArray(aiVisibilityRuns.status, ["complete", …])
 *
 * `.set({ status: "complete" })` in `run.ts` is a write, `run.status ===
 * "complete"` is a plain JS branch, and `EMITTABLE_STATUSES` is a named list
 * with its own documented reason to exist — none of them are this, and none of
 * them match. If a future window genuinely must stay narrower than settled,
 * give it a named, commented constant the way `EMITTABLE_STATUSES` does rather
 * than widening this pattern.
 */

const FEATURE_DIRS = [
  resolve(__dirname, "../../../src/lib/ai-visibility"),
  resolve(__dirname, "../../../src/app/(dashboard)/ai-visibility"),
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(path) ? [path] : [];
  });
}

/** `eq(aiVisibilityRuns.status, "complete")` — the exact hand-roll. */
const EQ_COMPLETE = /\beq\(\s*aiVisibilityRuns\.status\s*,\s*["']complete["']\s*\)/g;
/** `inArray(aiVisibilityRuns.status, [ … "complete" … ])` — the same mistake, spelled longer. */
const INARRAY_LITERAL_COMPLETE = /\binArray\(\s*aiVisibilityRuns\.status\s*,\s*\[[^\]]*["']complete["'][^\]]*\]/g;

describe("SETTLED_RUN_STATUSES is the only run-status admission rule", () => {
  it("still names all three settled statuses", () => {
    expect([...SETTLED_RUN_STATUSES]).toEqual(["complete", "paused_by_cap", "cancelled"]);
  });

  it("has no hand-rolled `status = complete` filter anywhere in the feature", () => {
    const offenders: string[] = [];
    for (const dir of FEATURE_DIRS) {
      for (const file of sourceFiles(dir)) {
        const source = readFileSync(file, "utf8");
        for (const pattern of [EQ_COMPLETE, INARRAY_LITERAL_COMPLETE]) {
          // `matchAll` needs the lastIndex reset between files on a shared /g regex.
          pattern.lastIndex = 0;
          for (const match of source.matchAll(pattern)) {
            const line = source.slice(0, match.index ?? 0).split("\n").length;
            offenders.push(`${relative(process.cwd(), file)}:${line} — ${match[0]}`);
          }
        }
      }
    }

    expect(
      offenders,
      "Import SETTLED_RUN_STATUSES from @/lib/ai-visibility/metrics instead:\n" + offenders.join("\n")
    ).toEqual([]);
  });
});
