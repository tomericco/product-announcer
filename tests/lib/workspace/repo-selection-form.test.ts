import { describe, it, expect } from "vitest";
import { parseRepoSelections } from "../../../src/lib/workspace/repo-selection-form";

function buildFormData(entries: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    formData.set(key, value);
  }
  return formData;
}

describe("parseRepoSelections", () => {
  it("returns only the checked repos, with their branch", () => {
    const formData = buildFormData({
      repoCount: "3",
      "repo-0-fullName": "acme/widgets",
      "repo-0-selected": "on",
      "repo-0-branch": "main",
      "repo-1-fullName": "acme/gadgets",
      "repo-1-branch": "develop",
      // repo-1-selected intentionally absent (unchecked)
      "repo-2-fullName": "acme/tools",
      "repo-2-selected": "on",
      "repo-2-branch": "release",
    });

    expect(parseRepoSelections(formData)).toEqual([
      { fullName: "acme/widgets", branch: "main" },
      { fullName: "acme/tools", branch: "release" },
    ]);
  });

  it("skips a checked repo with a blank branch", () => {
    const formData = buildFormData({
      repoCount: "1",
      "repo-0-fullName": "acme/widgets",
      "repo-0-selected": "on",
      "repo-0-branch": "   ",
    });

    expect(parseRepoSelections(formData)).toEqual([]);
  });

  it("returns an empty array when nothing is selected", () => {
    const formData = buildFormData({ repoCount: "0" });
    expect(parseRepoSelections(formData)).toEqual([]);
  });
});
