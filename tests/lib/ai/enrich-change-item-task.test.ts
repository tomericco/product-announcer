import { describe, it, expect } from "vitest";
import { buildEnrichmentPrompt } from "../../../src/lib/ai/enrich-change-item";

describe("buildEnrichmentPrompt (task)", () => {
  it("includes the task title and description", () => {
    const prompt = buildEnrichmentPrompt({
      tenantId: "t1",
      type: "task",
      repoName: "",
      taskTitle: "Add dark mode",
      taskDescription: "Users can toggle a dark theme in settings.",
    });
    expect(prompt).toContain("Add dark mode");
    expect(prompt).toContain("Users can toggle a dark theme in settings.");
    expect(prompt).toContain("Task");
  });
});
