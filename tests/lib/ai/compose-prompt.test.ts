import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../../src/lib/ai/compose-prompt";
import { serializeAtomicUpdates, composeReleasePrompt, composeMergePrompt } from "../../../src/lib/ai/compose-prompt";
import { composeBriefPrompt, serializeBriefEvidence } from "../../../src/lib/ai/compose-prompt";

describe("buildSystemPrompt", () => {
  const baseBrand = { guidelines: null, industry: null, userPersonas: [] };

  it("wraps the guidelines document in a delimited block when set", () => {
    const doc = "## Voice and tone\n\nPlain and direct.";
    const system = buildSystemPrompt({ ...baseBrand, guidelines: doc } as never, [], []);
    expect(system).toContain("Follow these brand writing guidelines, written by the team:");
    expect(system).toContain("<brand-guidelines>");
    expect(system).toContain(doc);
    expect(system).toContain("</brand-guidelines>");
  });

  it("omits the block entirely when guidelines are null or blank", () => {
    expect(buildSystemPrompt(baseBrand as never, [], [])).not.toContain("<brand-guidelines>");
    const blank = buildSystemPrompt({ ...baseBrand, guidelines: "   \n  " } as never, [], []);
    expect(blank).not.toContain("<brand-guidelines>");
  });

  it("truncates a document longer than the cap and marks it", () => {
    const system = buildSystemPrompt({ ...baseBrand, guidelines: "x".repeat(6500) } as never, [], []);
    expect(system).toContain("…(truncated)");
    expect(system).not.toContain("x".repeat(6100));
  });

  it("renders persona identity in parentheses when a description is present", () => {
    const withDesc = buildSystemPrompt(baseBrand as never, [{ name: "Developer", brief: "cares about APIs", description: "Engineers who integrate" }], []);
    expect(withDesc).toContain("Developer (Engineers who integrate): cares about APIs");
    const withoutDesc = buildSystemPrompt(baseBrand as never, [{ name: "Ops", brief: "runs infra" }], []);
    expect(withoutDesc).toContain("Ops: runs infra");
    expect(withoutDesc).not.toContain("Ops (");
  });

  it("keeps the examples block after the guidelines block", () => {
    const system = buildSystemPrompt(
      { ...baseBrand, guidelines: "## Do\n\n- Be brief." } as never,
      [],
      [{ category: "new", title: "Dark mode", body: "We shipped dark mode." } as never]
    );
    expect(system.indexOf("</brand-guidelines>")).toBeLessThan(system.indexOf("Dark mode"));
  });

  it("omits the category parenthetical for an example with a null category", () => {
    const system = buildSystemPrompt(
      baseBrand as never,
      [],
      [{ category: null, title: "New blog post", body: "Some body." } as never]
    );
    expect(system).toContain("Example:\nTitle: New blog post");
    expect(system).not.toContain("Example (null)");
  });
});

const AUS = [
  { id: "a1", title: "CSV export", summary: "Export reports as CSV.", category: "new" as const, size: "m" as const },
  { id: "a2", title: "Faster search", summary: "Search returns in under a second.", category: "improvement" as const, size: "m" as const },
];

describe("serializeAtomicUpdates", () => {
  it("renders each atomic update as a numbered title + summary line", () => {
    const text = serializeAtomicUpdates(AUS);
    expect(text).toContain("CSV export");
    expect(text).toContain("Export reports as CSV.");
    expect(text).toMatch(/1\./);
    expect(text).toMatch(/2\./);
  });

  it("drops trailing items past maxChars with a note, keeping at least one", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `a${i}`, title: `Feature ${i}`, summary: "x".repeat(200), category: "new" as const, size: "m" as const,
    }));
    const text = serializeAtomicUpdates(many, 500);
    expect(text).toMatch(/more updates not shown/);
    expect(text).toContain("Feature 0");
  });
});

const BASE_BRAND = { guidelines: null, industry: null, userPersonas: [] } as never;

describe("composeReleasePrompt", () => {
  it("builds a system+prompt pair from atomic updates without a repo map", () => {
    const { system, prompt } = composeReleasePrompt({
      items: AUS,
      brandProfile: BASE_BRAND,
      personas: [],
      examples: [],
    });
    expect(system).toContain("product update");
    expect(prompt).toContain("CSV export");
  });
});

describe("composeMergePrompt", () => {
  it("includes the current body and the new items in the prompt", () => {
    const { prompt } = composeMergePrompt({
      currentBody: "## What's new\nWe shipped CSV export last week.",
      newItems: [AUS[1]],
      changedItems: [],
      brandProfile: BASE_BRAND,
      personas: [],
      examples: [],
    });
    expect(prompt).toContain("We shipped CSV export last week.");
    expect(prompt).toContain("Faster search");
    expect(prompt).toContain("Search returns in under a second.");
  });

  it("includes changed items in the prompt when present", () => {
    const { prompt } = composeMergePrompt({
      currentBody: "Existing body.",
      newItems: [],
      changedItems: [AUS[0]],
      brandProfile: BASE_BRAND,
      personas: [],
      examples: [],
    });
    expect(prompt).toContain("CSV export");
    expect(prompt).toContain("Export reports as CSV.");
  });

  it("instructs the model to preserve existing wording and structure in the system prompt", () => {
    const { system } = composeMergePrompt({
      currentBody: "Existing body.",
      newItems: [AUS[0]],
      changedItems: [],
      brandProfile: BASE_BRAND,
      personas: [],
      examples: [],
    });
    expect(system).toContain("product update");
    expect(system.toLowerCase()).toContain("preserve");
    expect(system.toLowerCase()).toContain("existing wording");
  });
});

describe("size-aware composition", () => {
  it("serializes size + category and includes the size guidance", () => {
    const { prompt } = composeReleasePrompt({
      items: [
        { id: "1", title: "Big feature", summary: "…", category: "new", size: "xl" },
        { id: "2", title: "Tiny fix", summary: "…", category: "fix", size: "s" },
        { id: "3", title: "Unsized", summary: "…", category: "improvement", size: null },
      ],
      brandProfile: BASE_BRAND,
      personas: [],
      examples: [],
    });
    expect(prompt).toContain(`"Big feature" (new, XL)`);
    expect(prompt).toContain(`"Tiny fix" (fix, S)`);
    expect(prompt).toContain(`"Unsized" (improvement)`); // no size token when null
    expect(prompt).toContain("gather them into a single bulleted list");
  });
});

const PROFILE = {
  tenantId: "t1",
  industry: "Design tooling",
  guidelines: null,
  userPersonas: [],
} as unknown as Parameters<typeof buildSystemPrompt>[0];

describe("buildSystemPrompt content types", () => {
  it("is byte-identical to the three-argument form when the type is omitted", () => {
    // The three existing product-update paths (release, merge, edit, extract)
    // call this with three arguments. If this ever differs, those prompts
    // changed silently and their output changed with them.
    expect(buildSystemPrompt(PROFILE, [], [])).toBe(buildSystemPrompt(PROFILE, [], [], "product_update"));
  });

  it("gives each content type its own role line", () => {
    const update = buildSystemPrompt(PROFILE, [], [], "product_update");
    const blog = buildSystemPrompt(PROFILE, [], [], "blog_post");
    const social = buildSystemPrompt(PROFILE, [], [], "social_post");

    expect(update).toContain("product update announcements");
    expect(blog).not.toContain("product update announcements");
    expect(social).not.toContain("product update announcements");
    expect(blog).not.toBe(social);
  });

  it("keeps the grounding, link and naming rules on EVERY content type", () => {
    for (const type of ["product_update", "blog_post", "social_post"] as const) {
      const system = buildSystemPrompt(PROFILE, [], [], type);
      // These three are universal by decision. The naming rule in particular was
      // chosen deliberately over relaxing it for non-product types.
      expect(system).toContain("never invent");
      expect(system).toContain("[add link]");
      expect(system).toMatch(/never name, compare to, or reference/i);
    }
  });
});

describe("composeBriefPrompt", () => {
  const BRIEF = {
    title: "Why localization breaks design systems",
    angle: "Teams discover it too late",
    whyNow: "Two vendors shipped multilingual tooling this month",
    keyPoints: ["Point one", "Point two"],
    contentType: "blog_post" as const,
    targetLength: 800,
  };

  it("separates the commission from the evidence", () => {
    const { prompt } = composeBriefPrompt({
      brief: BRIEF,
      evidence: [{ title: "Phrase ships X", kind: "market_news", excerpt: "Body text." }],
      brandProfile: PROFILE,
      personas: [],
      examples: [],
    });

    // The angle and key points are INSTRUCTIONS to follow; the signals are
    // source material to ground against. Merging them makes the model treat the
    // commission as just more evidence.
    expect(prompt).toContain("Teams discover it too late");
    expect(prompt).toContain("Point one");
    expect(prompt).toContain("Phrase ships X");
    expect(prompt.indexOf("Teams discover it too late")).toBeLessThan(prompt.indexOf("Phrase ships X"));
  });

  it("tells the model that names in the evidence must not be reproduced", () => {
    const { prompt, system } = composeBriefPrompt({
      brief: BRIEF,
      evidence: [{ title: "Phrase ships X", kind: "market_news", excerpt: null }],
      brandProfile: PROFILE,
      personas: [],
      examples: [],
    });
    // The evidence necessarily contains company names. Without this the naming
    // rule reads as contradicted by the material it is given.
    expect(`${system}\n${prompt}`).toMatch(/do not (repeat|reproduce|name)/i);
  });

  it("uses the brief's own content type for the system prompt", () => {
    const { system } = composeBriefPrompt({
      brief: { ...BRIEF, contentType: "social_post" },
      evidence: [],
      brandProfile: PROFILE,
      personas: [],
      examples: [],
    });
    expect(system).toBe(buildSystemPrompt(PROFILE, [], [], "social_post"));
  });
});

describe("serializeBriefEvidence", () => {
  it("drops trailing items past the cap with a note rather than truncating mid-item", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      title: `Signal ${i}`,
      kind: "market_news",
      excerpt: "x".repeat(200),
    }));
    const out = serializeBriefEvidence(items, 1_000);
    expect(out.length).toBeLessThan(1_500);
    expect(out).toMatch(/more signals not shown/);
    expect(out).toContain("Signal 0");
  });

  it("handles an item with no excerpt", () => {
    expect(() => serializeBriefEvidence([{ title: "T", kind: "shipped_work", excerpt: null }])).not.toThrow();
  });
});
