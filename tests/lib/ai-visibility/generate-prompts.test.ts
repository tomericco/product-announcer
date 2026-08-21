import { describe, it, expect } from "vitest";
import { checkPromptQuality } from "../../../src/lib/ai-visibility/generate-prompts";

const CONTEXT = { tenantName: "Acme", aliases: ["Acme Inc"] };

describe("checkPromptQuality", () => {
  it("passes a real buyer question", () => {
    expect(checkPromptQuality({ text: "best issue trackers for seed-stage startups", branded: false }, CONTEXT)).toBeNull();
    expect(checkPromptQuality({ text: "What is the best issue tracker for a 5-person team?", branded: false }, CONTEXT)).toBeNull();
    expect(checkPromptQuality({ text: "Linear vs Jira for small teams", branded: false }, CONTEXT)).toBeNull();
  });

  it("flags our own name in an unbranded prompt", () => {
    const reason = checkPromptQuality({ text: "is Acme good for startups?", branded: false }, CONTEXT);
    expect(reason).toMatch(/Acme/);
    expect(reason).toMatch(/brand check/i);
  });

  it("allows our name in a brand-check prompt", () => {
    expect(checkPromptQuality({ text: "what is Acme?", branded: true }, CONTEXT)).toBeNull();
    expect(checkPromptQuality({ text: "Acme pricing", branded: true }, CONTEXT)).toBeNull();
  });

  it("does not mistake a substring for the brand", () => {
    expect(checkPromptQuality({ text: "best acmegraph alternatives", branded: false }, CONTEXT)).toBeNull();
  });

  it("flags keyword-ese", () => {
    expect(checkPromptQuality({ text: "issue tracking software pricing", branded: false }, CONTEXT)).toMatch(
      /keyword/i
    );
    expect(checkPromptQuality({ text: "issue trackers", branded: false }, CONTEXT)).toMatch(/keyword/i);
  });

  it("flags a prompt over 25 words", () => {
    const long = `what is the best issue tracker for a small engineering team that also needs roadmapping and wants something cheaper than the incumbents in this space today`;
    expect(long.split(/\s+/)).toHaveLength(26);
    expect(checkPromptQuality({ text: long, branded: false }, CONTEXT)).toMatch(/Too long/);
  });

  it("flags two questions in one prompt", () => {
    expect(
      checkPromptQuality({ text: "what is the best issue tracker? and what does it cost?", branded: false }, CONTEXT)
    ).toMatch(/two questions/i);
  });

  it("works with no aliases supplied", () => {
    expect(checkPromptQuality({ text: "is Acme good for startups?", branded: false }, { tenantName: "Acme" })).toMatch(
      /Acme/
    );
  });
});
