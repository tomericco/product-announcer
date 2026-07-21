import { describe, it, expect } from "vitest";
import { filesInDiff, filterCommit, filterPullRequest, filterTask } from "../../../src/lib/change-events/filter";

const diffFor = (...files: string[]) =>
  files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n+x\n`).join("");

describe("filesInDiff", () => {
  it("extracts paths from diff headers", () => {
    expect(filesInDiff(diffFor("src/a.ts", "src/b.ts"))).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns an empty array for an empty diff", () => {
    expect(filesInDiff("")).toEqual([]);
  });
});

describe("filterCommit", () => {
  it("drops merge commits", () => {
    expect(filterCommit({ message: "Merge pull request #1", diff: diffFor("src/a.ts"), parentCount: 2 })).toEqual({
      drop: true,
      reason: "merge_commit",
    });
  });

  it("drops empty diffs", () => {
    expect(filterCommit({ message: "chore", diff: "   ", parentCount: 1 })).toEqual({
      drop: true,
      reason: "empty_diff",
    });
  });

  it("drops lockfile-only changes", () => {
    expect(filterCommit({ message: "bump deps", diff: diffFor("pnpm-lock.yaml"), parentCount: 1 })).toEqual({
      drop: true,
      reason: "lockfile_only",
    });
  });

  it("drops test-only changes", () => {
    const diff = diffFor("tests/lib/a.test.ts", "src/b.spec.ts");
    expect(filterCommit({ message: "add coverage", diff, parentCount: 1 })).toEqual({
      drop: true,
      reason: "test_only",
    });
  });

  it("keeps a commit touching both tests and source", () => {
    const diff = diffFor("tests/a.test.ts", "src/feature.ts");
    expect(filterCommit({ message: "add feature", diff, parentCount: 1 })).toEqual({ drop: false });
  });

  it("drops chore/docs/ci conventional prefixes", () => {
    for (const message of ["chore: tidy", "docs(readme): fix typo", "ci: bump runner"]) {
      expect(filterCommit({ message, diff: diffFor("src/a.ts"), parentCount: 1 })).toEqual({
        drop: true,
        reason: "chore_prefix",
      });
    }
  });

  it("keeps feat and fix prefixes", () => {
    expect(filterCommit({ message: "feat: add export", diff: diffFor("src/a.ts"), parentCount: 1 })).toEqual({
      drop: false,
    });
    expect(filterCommit({ message: "fix: timeout", diff: diffFor("src/a.ts"), parentCount: 1 })).toEqual({
      drop: false,
    });
  });

  it("does not treat a bare word starting with chore as a prefix", () => {
    expect(filterCommit({ message: "choreography tweaks", diff: diffFor("src/a.ts"), parentCount: 1 })).toEqual({
      drop: false,
    });
  });
});

describe("filterPullRequest", () => {
  it("drops chore-prefixed PR titles", () => {
    expect(filterPullRequest({ title: "chore: bump deps" })).toEqual({ drop: true, reason: "chore_prefix" });
  });

  it("keeps a normal PR title", () => {
    expect(filterPullRequest({ title: "Add CSV export" })).toEqual({ drop: false });
  });
});

describe("filterTask", () => {
  it("drops a task with an empty title", () => {
    expect(filterTask({ title: "  ", description: "something" })).toEqual({ drop: true, reason: "empty_task" });
  });

  it("drops a task with no description", () => {
    expect(filterTask({ title: "Ship export", description: null })).toEqual({ drop: true, reason: "empty_task" });
  });

  it("keeps a described task", () => {
    expect(filterTask({ title: "Ship export", description: "Adds CSV export." })).toEqual({ drop: false });
  });
});
