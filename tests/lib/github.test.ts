import { describe, it, expect } from "vitest";
import { vi } from "vitest";
import { truncateDiff, listRepoBranches, getGithubApp } from "../../src/lib/github";

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
