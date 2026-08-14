import { describe, it, expect } from "vitest";
import { renderBriefBody, briefBody, type BriefBodyFields } from "../../../src/lib/briefs/body";

const fullFields: BriefBodyFields = {
  angle: "Ship the new export flow as the headline.",
  whyNow: "Competitors just announced the same thing.",
  keyPoints: ["Faster exports", "CSV and JSON support", "No size limit"],
  audience: "Existing power users on the Team plan.",
};

describe("renderBriefBody", () => {
  it("renders all sections when every field is present", () => {
    expect(renderBriefBody(fullFields)).toBe(
      [
        "## Angle",
        "Ship the new export flow as the headline.",
        "",
        "## Why now",
        "Competitors just announced the same thing.",
        "",
        "## Key points",
        "- Faster exports",
        "- CSV and JSON support",
        "- No size limit",
        "",
        "## Audience",
        "Existing power users on the Team plan.",
      ].join("\n")
    );
  });

  it("omits the Audience heading entirely when audience is null", () => {
    const body = renderBriefBody({ ...fullFields, audience: null });

    expect(body).not.toContain("## Audience");
    expect(body).toBe(
      [
        "## Angle",
        "Ship the new export flow as the headline.",
        "",
        "## Why now",
        "Competitors just announced the same thing.",
        "",
        "## Key points",
        "- Faster exports",
        "- CSV and JSON support",
        "- No size limit",
      ].join("\n")
    );
  });

  it("omits the Key points heading entirely when keyPoints is empty", () => {
    const body = renderBriefBody({ ...fullFields, keyPoints: [] });

    expect(body).not.toContain("## Key points");
    expect(body).toBe(
      [
        "## Angle",
        "Ship the new export flow as the headline.",
        "",
        "## Why now",
        "Competitors just announced the same thing.",
        "",
        "## Audience",
        "Existing power users on the Team plan.",
      ].join("\n")
    );
  });

  it("never includes the title, which is not part of the body", () => {
    const body = renderBriefBody(fullFields);

    // The title lives on a separate column/control entirely; renderBriefBody
    // is never given one, so this is really just guarding the fields list
    // doesn't grow a `title` by accident.
    expect(body).not.toContain("Ship the new export flow as the headline.\nShip");
    expect(Object.keys(fullFields)).not.toContain("title");
  });
});

describe("briefBody", () => {
  it("returns the stored body when present, ignoring the structured fields", () => {
    const stored = "# Hand-written\n\nSomeone edited this brief directly.";

    expect(briefBody({ ...fullFields, body: stored })).toBe(stored);
  });

  it("falls back to renderBriefBody, byte-identical to calling it directly", () => {
    // This equality is the entire justification for shipping without a
    // backfill: a null body must render exactly what the renderer produces
    // for the same fields, today and after any future edit to the renderer.
    const rendered = renderBriefBody(fullFields);

    expect(briefBody({ ...fullFields, body: null })).toBe(rendered);
    expect(briefBody({ ...fullFields, body: null })).toStrictEqual(rendered);
  });
});
