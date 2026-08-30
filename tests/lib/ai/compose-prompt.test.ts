import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../../src/lib/ai/compose-prompt";
import { serializeAtomicUpdates, composeReleasePrompt, composeMergePrompt, fillTemplate } from "../../../src/lib/ai/compose-prompt";
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
  { id: "a1", title: "CSV export", summary: "Export reports as CSV.", category: "new" as const, size: "m" as const, sizeEditedAt: null, latestEvidenceAt: null },
  { id: "a2", title: "Faster search", summary: "Search returns in under a second.", category: "improvement" as const, size: "m" as const, sizeEditedAt: null, latestEvidenceAt: null },
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
      sizeEditedAt: null, latestEvidenceAt: null,
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
      template: null,
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
      releaseItems: AUS,
      brandProfile: BASE_BRAND,
      personas: [],
      examples: [],
      template: null,
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
      releaseItems: AUS,
      brandProfile: BASE_BRAND,
      personas: [],
      examples: [],
      template: null,
    });
    expect(prompt).toContain("CSV export");
    expect(prompt).toContain("Export reports as CSV.");
  });

  it("instructs the model to preserve existing wording and structure in the system prompt", () => {
    const { system } = composeMergePrompt({
      currentBody: "Existing body.",
      newItems: [AUS[0]],
      changedItems: [],
      releaseItems: AUS,
      brandProfile: BASE_BRAND,
      personas: [],
      examples: [],
      template: null,
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
        { id: "1", title: "Big feature", summary: "…", category: "new", size: "xl", sizeEditedAt: null, latestEvidenceAt: null },
        { id: "2", title: "Tiny fix", summary: "…", category: "fix", size: "s", sizeEditedAt: null, latestEvidenceAt: null },
        { id: "3", title: "Unsized", summary: "…", category: "improvement", size: null, sizeEditedAt: null, latestEvidenceAt: null },
      ],
      brandProfile: BASE_BRAND,
      personas: [],
      examples: [],
      template: null,
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

  it("keeps the grounding and link rules on EVERY content type", () => {
    for (const type of ["product_update", "blog_post", "social_post"] as const) {
      const system = buildSystemPrompt(PROFILE, [], [], type);
      // Universal, and the reason relaxing the naming rule is safe: whatever a
      // draft says about another company still has to come from the sources.
      expect(system).toContain("never invent");
      expect(system).toContain("[add link]");
    }
  });

  it("carries the guidelines' voice but not their structure into a non-product piece", () => {
    // The guidelines document is derived from the company's changelog, so it
    // prescribes changelog conventions. Applying it wholesale to a blog post
    // produced a fabricated "UX impact / May 15, 2025" header and a sign-off on
    // the first live run — neither present in any source.
    const withGuidelines = {
      ...PROFILE,
      guidelines: "## Voice\n\nHelpful and concrete.\n\n## Do\n\n- Open with what shipped\n",
    } as unknown as Parameters<typeof buildSystemPrompt>[0];

    const update = buildSystemPrompt(withGuidelines, [], [], "product_update");
    expect(update).toContain("Follow these brand writing guidelines");
    expect(update).not.toMatch(/not for this piece/i);

    for (const type of ["blog_post", "social_post"] as const) {
      const system = buildSystemPrompt(withGuidelines, [], [], type);
      // The team's own words still reach the model — it is only their
      // structural conventions that are disclaimed.
      expect(system).toContain("Helpful and concrete.");
      expect(system).toMatch(/written by the team for the company's PRODUCT UPDATES/);
      expect(system).toMatch(/only the voice/i);
      // The three artifacts observed live, named so the model cannot reproduce
      // them by pattern-matching the guidelines' format.
      expect(system).toMatch(/date line/i);
      expect(system).toMatch(/sign-off/i);
      expect(system).toMatch(/percentages or metrics/i);
    }
  });

  it("emits no guidelines block at all when the team has written none", () => {
    for (const type of ["product_update", "blog_post", "social_post"] as const) {
      // PROFILE.guidelines is null. The disclaimer must not appear on its own,
      // describing a document that was never supplied.
      expect(buildSystemPrompt(PROFILE, [], [], type)).not.toContain("<brand-guidelines>");
      expect(buildSystemPrompt(PROFILE, [], [], type)).not.toMatch(/PRODUCT UPDATES, not for this piece/);
    }
  });

  it("forbids naming other companies in a product update, and permits it elsewhere", () => {
    // Reversed on 2026-08-06. A product announcement has no business naming
    // anyone else; an industry blog post that refuses to say who shipped the
    // thing it is about reads as evasive.
    expect(buildSystemPrompt(PROFILE, [], [], "product_update")).toMatch(
      /never name, compare to, or reference/i
    );

    for (const type of ["blog_post", "social_post"] as const) {
      const system = buildSystemPrompt(PROFILE, [], [], type);
      expect(system).not.toMatch(/never name, compare to, or reference/i);
      expect(system).toMatch(/may name other companies/i);
      // Permission to name is not permission to invent: an unsupported
      // comparison is still out of bounds.
      expect(system).toMatch(/never state a comparison, ranking, or claim/i);
    }
  });
});

describe("composeBriefPrompt", () => {
  const BRIEF = {
    title: "Why localization breaks design systems",
    body: "## Angle\nTeams discover it too late\n\n## Key points\n- Point one\n- Point two",
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

    // The body is the INSTRUCTION to follow; the signals are source material to
    // ground against. Merging them makes the model treat the commission as just
    // more evidence.
    expect(prompt).toContain("Teams discover it too late");
    expect(prompt).toContain("Point one");
    expect(prompt).toContain("Phrase ships X");
    expect(prompt.indexOf("Teams discover it too late")).toBeLessThan(prompt.indexOf("Phrase ships X"));
  });

  it("carries the body verbatim, and keeps the title and shape instructions out of it", () => {
    const { prompt } = composeBriefPrompt({
      brief: BRIEF,
      evidence: [],
      brandProfile: PROFILE,
      personas: [],
      examples: [],
    });

    // Verbatim: the commission the model reads is the document the human
    // edited, markdown headings and all — not a re-rendering of it.
    expect(prompt).toContain(BRIEF.body);
    // Title, target length and format guidance are instructions about the
    // piece's shape, not commission prose, and stay as their own lines.
    expect(prompt).toContain(`Write this piece. Title: "${BRIEF.title}".`);
    expect(prompt).toContain("Target length: about 800 words.");
  });

  it("requires anything said about another company to come from the sources", () => {
    const { prompt } = composeBriefPrompt({
      brief: BRIEF,
      evidence: [{ title: "Phrase ships X", kind: "market_news", excerpt: null }],
      brandProfile: PROFILE,
      personas: [],
      examples: [],
    });
    // A blog post may now name companies, so the evidence block's job changed:
    // it no longer forbids reproducing names, it anchors what may be said about
    // them. Without this, permission to name reads as permission to invent.
    expect(prompt).toMatch(/ground every factual claim/i);
    expect(prompt).toMatch(/about another company/i);
  });

  /**
   * The join between commission blocks. Nothing pinned this while every
   * element was a single line, and a `"\n"` join survived the body landing
   * among them — so a rendered prompt had `Target length:` sitting directly
   * beneath the body's closing line and `FORMAT_GUIDANCE` directly beneath
   * that. Instructions glued onto commission prose stop reading as
   * instructions; when the body ends in a list they read as another bullet.
   *
   * The body here deliberately ends in a list, which is the worst case, and
   * the negative assertions are the real pin: they fail the moment ANYTHING
   * is joined onto the body's last line, whatever it happens to be.
   */
  const LIST_BODY = "## Angle\nTeams discover it too late\n\n## Key points\n- Point one\n- Point two";

  it("puts a blank line between every commission block", () => {
    const { prompt } = composeBriefPrompt({
      brief: { ...BRIEF, body: LIST_BODY },
      evidence: [],
      brandProfile: PROFILE,
      personas: [],
      examples: [],
    });

    // Title line -> body: without the blank line the instruction runs straight
    // into the body's first heading.
    expect(prompt).toContain(`Write this piece. Title: "${BRIEF.title}".\n\n## Angle`);
    // Body -> target length: the regression the reviewer caught in a dump.
    expect(prompt).toContain("- Point two\n\nTarget length: about 800 words.");
    // Target length -> format guidance.
    expect(prompt).toMatch(/Target length: about 800 words\.\n\nFormat the body as Markdown/);
    // Nothing at all is glued onto the body's last line. This is what fails if
    // the join reverts to "\n", regardless of what follows the body.
    expect(prompt).not.toMatch(/- Point two\n(?!\n)/);
  });

  it("still blank-line separates when there is no target length", () => {
    // The path where FORMAT_GUIDANCE follows the body directly — with a "\n"
    // join it becomes a third bullet under "## Key points".
    const { prompt } = composeBriefPrompt({
      brief: { ...BRIEF, body: LIST_BODY, targetLength: null },
      evidence: [],
      brandProfile: PROFILE,
      personas: [],
      examples: [],
    });

    expect(prompt).not.toContain("Target length");
    expect(prompt).toMatch(/- Point two\n\nFormat the body as Markdown/);
    expect(prompt).not.toMatch(/- Point two\n(?!\n)/);
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

const TEMPLATE_ITEM = {
  id: "a1",
  title: "Shared dashboards",
  summary: "Share a dashboard with your team.",
  category: "new" as const,
  size: "l" as const,
  sizeEditedAt: null,
  latestEvidenceAt: new Date("2026-08-20T00:00:00Z"),
};

const EXAMPLE = {
  category: "new",
  title: "Dark mode",
  body: "We shipped dark mode across the whole app.",
} as never as Parameters<typeof buildSystemPrompt>[2][number];

describe("composeReleasePrompt with a template", () => {
  const base = { items: [TEMPLATE_ITEM], brandProfile: PROFILE, personas: [], examples: [] };

  it("fences the template", () => {
    const { prompt } = composeReleasePrompt({ ...base, template: "# Updates\n\n## Highlights\n" });
    expect(prompt).toContain("<template>");
    expect(prompt).toContain("</template>");
    expect(prompt).toContain("## Highlights");
  });

  it("substitutes variables before the model sees them", () => {
    const { prompt } = composeReleasePrompt({ ...base, template: "# {count} updates in {month}\n" });
    expect(prompt).toContain("1 updates in August");
    expect(prompt).not.toContain("{count}");
    expect(prompt).not.toContain("{month}");
  });

  it("orders items most-significant-first", () => {
    const small = { ...TEMPLATE_ITEM, id: "a2", title: "Tiny fix", size: "s" as const };
    const { prompt } = composeReleasePrompt({ ...base, items: [small, TEMPLATE_ITEM], template: "## Highlights\n" });
    expect(prompt.indexOf("Shared dashboards")).toBeLessThan(prompt.indexOf("Tiny fix"));
  });

  it("tells the model the numbers are authoritative", () => {
    const { prompt } = composeReleasePrompt({ ...base, template: "# {count} updates\n" });
    expect(prompt.toLowerCase()).toContain("authoritative");
  });

  it("lets a human-pinned size win a tie against an unpinned one", () => {
    const pinned = { ...TEMPLATE_ITEM, id: "a3", title: "Pinned change", sizeEditedAt: new Date("2026-08-01T00:00:00Z") };
    const { prompt } = composeReleasePrompt({ ...base, items: [TEMPLATE_ITEM, pinned], template: "## Highlights\n" });
    expect(prompt.indexOf("Pinned change")).toBeLessThan(prompt.indexOf("Shared dashboards"));
  });

  it("dates the period from the work's evidence, not the composition date", () => {
    // {month}/{year} describe the period the work landed in. A changelog
    // written in September about August work says August.
    const { prompt } = composeReleasePrompt({ ...base, template: "# {month} {year}\n" });
    expect(prompt).toContain("August 2026");
  });
});

describe("fillTemplate", () => {
  it("derives the evidence date itself, so a caller cannot get it wrong", () => {
    const older = { ...TEMPLATE_ITEM, id: "a4", latestEvidenceAt: new Date("2026-07-01T00:00:00Z") };
    // Task 7's reviewer calls this on the same items and must agree with the
    // composer about what {count} and {month} were.
    expect(fillTemplate("{count} in {month}", [TEMPLATE_ITEM, older])).toBe("2 in August");
  });

  it("falls back to the composition date when no item carries evidence", () => {
    const undated = { ...TEMPLATE_ITEM, latestEvidenceAt: null };
    const thisYear = String(new Date().getUTCFullYear());
    expect(fillTemplate("{year}", [undated])).toBe(thisYear);
  });
});

describe("composeMergePrompt with a template", () => {
  it("fences the template and frames it as the shape the body already follows", () => {
    const { system, prompt } = composeMergePrompt({
      currentBody: "## Highlights\n\nExisting text.",
      newItems: [TEMPLATE_ITEM],
      changedItems: [],
      releaseItems: [TEMPLATE_ITEM],
      brandProfile: PROFILE,
      personas: [],
      examples: [],
      template: "## Highlights\n\n## Fixes\n",
    });
    expect(prompt + system).toContain("## Fixes");
  });

  it("counts the whole release, not just the delta being folded in", () => {
    // The delta is what the model is asked to fold in; the template's numbers
    // describe the FINISHED piece. Substituting over the delta put "1 updates"
    // into the skeleton of a three-update release — invisible in the H1 (which
    // `parseTemplate` strips) but not in a body section.
    const others = [
      { ...TEMPLATE_ITEM, id: "b1", title: "Already written up" },
      { ...TEMPLATE_ITEM, id: "b2", title: "Also already written up" },
    ];
    const { system } = composeMergePrompt({
      currentBody: "## This month\n\n2 updates this month.",
      newItems: [TEMPLATE_ITEM],
      changedItems: [],
      releaseItems: [...others, TEMPLATE_ITEM],
      brandProfile: PROFILE,
      personas: [],
      examples: [],
      template: "## {count} updates this month\n",
    });
    expect(system).toContain("3 updates this month");
    expect(system).not.toContain("1 updates this month");
  });

  it("tells the model the numbers are authoritative, as the release path does", () => {
    const { system } = composeMergePrompt({
      currentBody: "body",
      newItems: [TEMPLATE_ITEM],
      changedItems: [],
      releaseItems: [TEMPLATE_ITEM],
      brandProfile: PROFILE,
      personas: [],
      examples: [],
      template: "## {count} updates\n",
    });
    expect(system.toLowerCase()).toContain("authoritative");
  });

  it("drops the size guidance when a template is present, and keeps it when it is not", () => {
    // SIZE_GUIDANCE prescribes its own structure ("gather them into a single
    // bulleted list"), which contradicts a skeleton's literal sections. The
    // release path already omits it under a template; these must not disagree.
    const base = {
      currentBody: "body",
      newItems: [TEMPLATE_ITEM],
      changedItems: [],
      releaseItems: [TEMPLATE_ITEM],
      brandProfile: PROFILE,
      personas: [],
      examples: [],
    };
    const templated = composeMergePrompt({ ...base, template: "## Highlights\n" });
    expect(templated.prompt).not.toContain("gather them into a single bulleted list");

    const untemplated = composeMergePrompt({ ...base, template: null });
    expect(untemplated.prompt).toContain("gather them into a single bulleted list");
  });

  it("renders today's prompt when no template is configured", () => {
    const { prompt } = composeMergePrompt({
      currentBody: "body", newItems: [TEMPLATE_ITEM], changedItems: [],
      releaseItems: [TEMPLATE_ITEM],
      brandProfile: PROFILE, personas: [], examples: [], template: null,
    });
    expect(prompt).not.toContain("<template>");
  });
});

describe("composeReleasePrompt without a template", () => {
  it("renders exactly what it rendered before templates existed", () => {
    const withNull = composeReleasePrompt({
      items: [TEMPLATE_ITEM], brandProfile: PROFILE, personas: [], examples: [], template: null,
    });
    expect(withNull.prompt).toContain("Here are the changes to summarize into one product update.");
    expect(withNull.prompt).not.toContain("<template>");
  });
});

describe("buildSystemPrompt for product updates", () => {
  it("no longer carries few-shot examples", () => {
    const { system } = composeReleasePrompt({
      items: [TEMPLATE_ITEM], brandProfile: PROFILE, personas: [], examples: [EXAMPLE], template: null,
    });
    expect(system).not.toContain(EXAMPLE.body);
  });
});
