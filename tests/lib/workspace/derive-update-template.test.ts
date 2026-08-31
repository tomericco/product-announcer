import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../../../src/lib/ai/llm-usage", () => ({ recordLlmUsage: vi.fn() }));

import { generateObject } from "ai";
import { deriveUpdateTemplate, postProcessTemplate } from "../../../src/lib/workspace/derive-update-template";

describe("deriveUpdateTemplate", () => {
  afterEach(() => vi.mocked(generateObject).mockReset());

  it("returns the derived skeleton", async () => {
    vi.mocked(generateObject).mockResolvedValue({
      object: { template: "# What's new in {month}\n\n## Highlights\n" },
      usage: {},
    } as never);

    expect(await deriveUpdateTemplate("page text", "tenant-1")).toBe(
      "# What's new in {month}\n\n## Highlights\n"
    );
  });

  it("returns null when the page shows no consistent structure", async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: { template: null }, usage: {} } as never);
    expect(await deriveUpdateTemplate("page text", "tenant-1")).toBeNull();
  });

  it("normalizes a blank derivation to null", async () => {
    vi.mocked(generateObject).mockResolvedValue({ object: { template: "   \n " }, usage: {} } as never);
    expect(await deriveUpdateTemplate("page text", "tenant-1")).toBeNull();
  });

  it("returns null rather than throwing when the model call fails", async () => {
    vi.mocked(generateObject).mockRejectedValue(new Error("boom"));
    expect(await deriveUpdateTemplate("page text", "tenant-1")).toBeNull();
  });
});

/**
 * The deterministic half of the derivation. Every case here is a failure
 * measured against a real changelog page on 2026-08-31 — the prompt asks the
 * model not to do these things and mostly succeeds, but "mostly" is not a
 * guarantee and an unknown token is invisible downstream by design.
 */
describe("postProcessTemplate", () => {
  it("keeps a clean skeleton unchanged", () => {
    const clean = "# {month} {year}\n\n## Fixes\n\n## Improvements";
    expect(postProcessTemplate(clean)).toBe(clean);
  });

  it("keeps described content slots — they are what a template is FOR", () => {
    // This is the inversion of an earlier rule. These braces used to be
    // stripped as invented junk; they are now the point. The composer reads an
    // unreserved brace as a brief for what to write there.
    const t = "# {main feature, plus 1-2 smaller ones} {month}\n\n## Fixes\n{the fixes, as bullets}";
    expect(postProcessTemplate(t)).toBe(t);
  });

  it("keeps every reserved variable", () => {
    const t = "# {count_rounded}+ updates in {month} {year}\n\n## Also fixed";
    const out = postProcessTemplate(t)!;
    expect(out).toContain("{count_rounded}");
    expect(out).toContain("{month}");
    expect(out).toContain("{year}");
  });

  it("returns null when only a title line survives", () => {
    // A body-less skeleton is worse than none: composition falls back to the
    // pre-template prompt anyway, while the UI reports a template configured.
    expect(postProcessTemplate("# {main feature} {month}")).toBeNull();
    expect(postProcessTemplate("# Changelog")).toBeNull();
  });

  it("returns null for whitespace", () => {
    expect(postProcessTemplate("   \n\n  ")).toBeNull();
  });

  it("keeps deliberate spacing, capping only runaway runs", () => {
    // Spacing is part of what a template carries — the air a company leaves
    // before a sign-off, or around a divider, is how their updates read.
    // Collapsing every gap to the markdown minimum produced a dense block.
    expect(postProcessTemplate("# Updates\n\n\n## Fixes")).toBe("# Updates\n\n\n## Fixes");
    expect(postProcessTemplate("# Updates\n\n\n\n\n## Fixes")).toBe("# Updates\n\n\n## Fixes");
  });

  it("drops a slot reserved for the category chip", () => {
    // Enforced here rather than asked for: the prompt has been rewritten three
    // times and the chip returns whenever extraction gets cleaner, because it
    // genuinely looks like structure — it recurs, in the same place, briefly.
    // A slot for it puts a stray word atop every future update.
    const out = postProcessTemplate("# {main feature} {month}\n\n{category label line}\n\n{the changes}")!;
    expect(out).not.toContain("category label");
    expect(out).toContain("{the changes}");
    expect(postProcessTemplate("# T\n\n{update type}\n\n{body}")!).not.toContain("{update type}");
  });

  it("leaves a real description that merely mentions a classifying word", () => {
    // Narrow on purpose. A brief long enough to be a brief is content.
    const tpl = "# T\n\n{one paragraph explaining what changed and who it helps, by category}";
    expect(postProcessTemplate(tpl)).toBe(tpl);
  });

  it("keeps a divider", () => {
    const withRule = "# Updates\n\n{the changes}\n\n---\n\nTeam Acme";
    expect(postProcessTemplate(withRule)).toBe(withRule);
  });
});
