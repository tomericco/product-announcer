export type FilterReason =
  | "merge_commit"
  | "empty_diff"
  | "lockfile_only"
  | "test_only"
  | "chore_prefix"
  | "empty_task";

export type FilterVerdict = { drop: true; reason: FilterReason } | { drop: false };

const KEEP: FilterVerdict = { drop: false };

// Conventional-commit types that never produce user-facing news. The colon or
// scope-paren is required, so "choreography" is not a chore commit. A `!`
// breaking-change marker (e.g. "chore!:", "refactor(api)!:") must never be
// treated as noise — it always falls through to the classifier, since `!`
// means the change is user-facing by definition.
const NOISE_PREFIX = /^(chore|docs|ci|build|style|test|refactor)(\([^)]*\))?:/i;

const LOCKFILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
  "go.sum",
  "composer.lock",
]);

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i;

/** Extracts changed file paths from a unified diff's `diff --git` headers. */
export function filesInDiff(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    const match = /^diff --git a\/(.+?) b\//.exec(line);
    if (match) files.push(match[1]);
  }
  return files;
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function filterCommit(input: { message: string; diff: string; parentCount: number }): FilterVerdict {
  if (input.parentCount >= 2) return { drop: true, reason: "merge_commit" };
  if (input.diff.trim() === "") return { drop: true, reason: "empty_diff" };
  if (NOISE_PREFIX.test(input.message.trim())) return { drop: true, reason: "chore_prefix" };

  const files = filesInDiff(input.diff);
  if (files.length > 0) {
    if (files.every((f) => LOCKFILES.has(basename(f)))) return { drop: true, reason: "lockfile_only" };
    if (files.every((f) => TEST_PATH.test(f))) return { drop: true, reason: "test_only" };
  }

  return KEEP;
}

export function filterPullRequest(input: { title: string }): FilterVerdict {
  if (NOISE_PREFIX.test(input.title.trim())) return { drop: true, reason: "chore_prefix" };
  return KEEP;
}

export function filterTask(input: { title: string; description: string | null }): FilterVerdict {
  // A task with a clear title is meaningful even when its body is empty — task
  // trackers often carry the whole signal in the title, and the tier-2
  // classifier weeds out low-signal ones. Only a title-less task is noise.
  if (input.title.trim() === "") return { drop: true, reason: "empty_task" };
  return KEEP;
}
