import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));

import { generateObject } from "ai";
import { buildReviewPrompt, reviewAndReconcile } from "../../src/lib/review-draft";

const draft = { title: "Big news!!!", body: "Buy now.", category: "new" as const };
const brand = { tone: "calm", readingLevel: "simple", doList: ["be factual"], dontList: ["hype"], examplePhrases: ["ship"], industry: null, userPersonas: [] };

function ok(object: unknown) { return { object } as never; }

describe("buildReviewPrompt", () => {
  it("includes the brand rules and the draft", () => {
    const prompt = buildReviewPrompt(draft, brand as never);
    expect(prompt).toContain("Tone: calm.");
    expect(prompt).toContain("Reading level: simple.");
    expect(prompt).toContain("Do: be factual.");
    expect(prompt).toContain("Avoid: hype.");
    expect(prompt).toContain("Preferred phrasing: ship.");
    expect(prompt).toContain("Big news!!!");
    expect(prompt).toContain("Buy now.");
  });
});

describe("reviewAndReconcile", () => {
  beforeEach(() => {
    vi.mocked(generateObject).mockReset();
  });

  it("returns passed and the original draft when the first review is compliant", async () => {
    vi.mocked(generateObject).mockResolvedValue(ok({ compliant: true, issues: [], revised: null }));
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out).toEqual({ finalDraft: draft, status: "passed", issues: [] });
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("revises and returns 'revised' when the rewrite becomes compliant", async () => {
    vi.mocked(generateObject)
      .mockResolvedValueOnce(ok({ compliant: false, issues: ["too hypey"], revised: { title: "News", body: "We shipped X." } }))
      .mockResolvedValueOnce(ok({ compliant: true, issues: [], revised: null }));
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out.status).toBe("revised");
    expect(out.finalDraft).toEqual({ title: "News", body: "We shipped X.", category: "new" });
    expect(out.issues).toEqual([]);
    expect(generateObject).toHaveBeenCalledTimes(2);
  });

  it("returns 'failed' with issues when the rewrite is still non-compliant", async () => {
    vi.mocked(generateObject)
      .mockResolvedValueOnce(ok({ compliant: false, issues: ["too hypey"], revised: { title: "News", body: "Still hype." } }))
      .mockResolvedValueOnce(ok({ compliant: false, issues: ["still hypey"], revised: null }));
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out.status).toBe("failed");
    expect(out.issues).toEqual(["still hypey"]);
    expect(out.finalDraft).toEqual({ title: "News", body: "Still hype.", category: "new" });
  });

  it("returns 'failed' with the original draft when non-compliant with no revision offered", async () => {
    vi.mocked(generateObject).mockResolvedValue(ok({ compliant: false, issues: ["bad"], revised: null }));
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out).toEqual({ finalDraft: draft, status: "failed", issues: ["bad"] });
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("retries the first review once, then returns 'error' if it keeps failing", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("review down"));
    const out = await reviewAndReconcile(draft, brand as never);
    expect(out).toEqual({ finalDraft: draft, status: "error", issues: [] });
    expect(generateObject).toHaveBeenCalledTimes(2);
  });
});
