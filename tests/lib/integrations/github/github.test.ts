import { describe, it, expect } from "vitest";
import { vi } from "vitest";
import {
  truncateDiff,
  listRepoBranches,
  getGithubApp,
  listPushCommits,
  getCommitPulls,
  capPushCommits,
} from "../../../../src/lib/integrations/github/github";

describe("truncateDiff", () => {
  it("returns short diffs unchanged", () => {
    const diff = "line1\nline2\nline3";
    expect(truncateDiff(diff)).toBe(diff);
  });

  it("caps a long diff at maxLines and marks it truncated", () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line${i}`);
    const diff = lines.join("\n");

    const result = truncateDiff(diff, 200);

    const resultLines = result.split("\n");
    expect(resultLines).toHaveLength(201); // 200 content lines + 1 marker
    expect(resultLines[200]).toBe("… (truncated, 50 more lines)");
  });
});

describe("listRepoBranches", () => {
  it("returns every branch name via pagination", async () => {
    const fakeOctokit = {
      paginate: vi.fn().mockResolvedValue([{ name: "main" }, { name: "develop" }, { name: "release/1.0" }]),
      rest: { repos: { listBranches: "LIST_BRANCHES_ENDPOINT" } },
    };
    const spy = vi
      .spyOn(getGithubApp(), "getInstallationOctokit")
      .mockResolvedValue(fakeOctokit as never);

    const branches = await listRepoBranches("42", "acme/web");

    expect(branches).toEqual(["main", "develop", "release/1.0"]);
    expect(fakeOctokit.paginate).toHaveBeenCalledWith("LIST_BRANCHES_ENDPOINT", {
      owner: "acme",
      repo: "web",
      per_page: 100,
    });
    spy.mockRestore();
  });
});

describe("capPushCommits", () => {
  it("returns the list unchanged at or under the cap", () => {
    const items = [1, 2, 3];
    expect(capPushCommits(items, 3, { repoFullName: "acme/x", before: "a", after: "b" })).toBe(items);
  });

  it("truncates over the cap and logs a breadcrumb", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const items = Array.from({ length: 5 }, (_, i) => i);
    const result = capPushCommits(items, 2, { repoFullName: "acme/x", before: "a", after: "b" });
    expect(result).toHaveLength(2);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("listPushCommits", () => {
  it("falls back to payload commits (no parents) for a new-branch push", async () => {
    const result = await listPushCommits("1", "acme/x", {
      before: "0000000000000000000000000000000000000000",
      after: "aaa",
      payloadCommits: [{ id: "aaa", message: "first", url: "https://x/aaa", timestamp: "2026-07-01T00:00:00Z" }],
    });
    expect(result).toEqual([{ sha: "aaa", message: "first", url: "https://x/aaa", committedAt: "2026-07-01T00:00:00Z", parents: [] }]);
  });

  it("enumerates the compare range with parents", async () => {
    const fakeOctokit = {
      paginate: vi.fn().mockResolvedValue([
        { sha: "c1", html_url: "https://x/c1", commit: { message: "feat", author: { date: "2026-07-01T00:00:00Z" } }, parents: [{ sha: "p1" }] },
        { sha: "m1", html_url: "https://x/m1", commit: { message: "Merge", author: { date: "2026-07-02T00:00:00Z" } }, parents: [{ sha: "p1" }, { sha: "p2" }] },
      ]),
      rest: { repos: { compareCommitsWithBasehead: "COMPARE_ENDPOINT" } },
    };
    const spy = vi.spyOn(getGithubApp(), "getInstallationOctokit").mockResolvedValue(fakeOctokit as never);

    const result = await listPushCommits("1", "acme/x", { before: "b0", after: "b1", payloadCommits: [] });

    expect(result.map((c) => ({ sha: c.sha, parents: c.parents }))).toEqual([
      { sha: "c1", parents: ["p1"] },
      { sha: "m1", parents: ["p1", "p2"] },
    ]);
    spy.mockRestore();
  });
});

describe("getCommitPulls", () => {
  it("maps associated PRs to merged flags", async () => {
    const fakeOctokit = {
      rest: { repos: { listPullRequestsAssociatedWithCommit: vi.fn().mockResolvedValue({ data: [
        { number: 7, merged_at: "2026-07-01T00:00:00Z" },
        { number: 8, merged_at: null },
      ] }) } },
    };
    const spy = vi.spyOn(getGithubApp(), "getInstallationOctokit").mockResolvedValue(fakeOctokit as never);

    const result = await getCommitPulls("1", "acme/x", "c1");

    expect(result).toEqual([{ number: 7, merged: true }, { number: 8, merged: false }]);
    spy.mockRestore();
  });
});
