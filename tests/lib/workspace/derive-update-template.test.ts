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

  it("keeps every allowed variable", () => {
    const t = "# {count_rounded}+ updates in {month} {year}\n\n## Also fixed";
    expect(postProcessTemplate(t)).toContain("{count_rounded}");
    expect(postProcessTemplate(t)).toContain("{month}");
    expect(postProcessTemplate(t)).toContain("{year}");
  });

  it("strips a placeholder the model invented", () => {
    // `substituteVariables` leaves an unrecognised token alone by design, so
    // anything not stripped here reaches the finished update as literal text.
    const out = postProcessTemplate("# Updates\n\n## What's new\n{Feature name}\n\n## Fixes");
    expect(out).not.toContain("{Feature name}");
    expect(out).toContain("## What's new");
    expect(out).toContain("## Fixes");
  });

  it("removes the separator orphaned by a stripped placeholder", () => {
    // `{month} {day}, {year}` must not become `{month} , {year}`.
    expect(postProcessTemplate("# {month} {day}, {year}\n\n## Fixes")).toBe("# {month} {year}\n\n## Fixes");
  });

  it("drops a heading left empty by stripping", () => {
    const out = postProcessTemplate("# Updates\n\n## {Section heading}\n\n## Fixes");
    expect(out).not.toMatch(/##\s*$/m);
    expect(out).toContain("## Fixes");
  });

  it("returns null when only a title line survives", () => {
    // A body-less skeleton is worse than none: composition falls back to the
    // pre-template prompt anyway, while the UI reports a template configured.
    expect(postProcessTemplate("# {title}")).toBeNull();
    expect(postProcessTemplate("# Changelog\n\n{Everything else}")).toBeNull();
  });

  it("returns null for whitespace", () => {
    expect(postProcessTemplate("   \n\n  ")).toBeNull();
  });

  it("collapses the blank-line runs stripping leaves behind", () => {
    expect(postProcessTemplate("# Updates\n\n{a}\n\n{b}\n\n## Fixes")).toBe("# Updates\n\n## Fixes");
  });
});
