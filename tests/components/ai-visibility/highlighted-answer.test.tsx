import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  HighlightedAnswer,
  segmentAnswer,
  type AnswerAlias,
} from "../../../src/app/(dashboard)/ai-visibility/prompts/[promptId]/highlighted-answer";

const ALIASES: AnswerAlias[] = [
  { name: "Versional", kind: "tenant", label: "Versional" },
  { name: "Lokalise", kind: "competitor", label: "Lokalise" },
  { name: "Phrase", kind: "competitor", label: "Phrase" },
];

function kinds(text: string, aliases = ALIASES) {
  return segmentAnswer(text, aliases).map((segment) => `${segment.kind}:${segment.text}`);
}

describe("segmentAnswer", () => {
  it("marks the tenant and a competitor in one pass", () => {
    expect(kinds("Try Versional or Lokalise.")).toEqual([
      "plain:Try ",
      "tenant:Versional",
      "plain: or ",
      "competitor:Lokalise",
      "plain:.",
    ]);
  });

  it("keeps two adjacent matches as two marks, with no empty segment between", () => {
    expect(kinds("VersionalLokalise", ALIASES)).toEqual(["plain:VersionalLokalise"]);
    // …and when they are genuinely adjacent as separate words:
    expect(kinds("Versional Lokalise")).toEqual(["tenant:Versional", "plain: ", "competitor:Lokalise"]);
    expect(segmentAnswer("Versional Lokalise", ALIASES).some((segment) => segment.text === "")).toBe(false);
  });

  it("prefers the longer match when two aliases overlap", () => {
    const overlapping: AnswerAlias[] = [
      { name: "Phrase", kind: "competitor", label: "Phrase" },
      { name: "Phrase TMS", kind: "competitor", label: "Phrase TMS" },
    ];
    expect(kinds("We compared Phrase TMS today.", overlapping)).toEqual([
      "plain:We compared ",
      "competitor:Phrase TMS",
      "plain: today.",
    ]);
  });

  it("respects word boundaries, so a name inside a word is not a mention", () => {
    expect(kinds("Versionality is not a product.")).toEqual(["plain:Versionality is not a product."]);
  });

  it("never marks a name inside a URL", () => {
    // The alias table's own rule, repeated here because this component gets
    // raw answer text and a URL is exactly where a brand name is not a
    // mention — it is a citation, counted elsewhere.
    expect(kinds("See https://lokalise.com/pricing for Lokalise pricing.")).toEqual([
      "plain:See https://lokalise.com/pricing for ",
      "competitor:Lokalise",
      "plain: pricing.",
    ]);
  });

  it("matches case-insensitively but preserves the answer's own casing", () => {
    expect(kinds("versional and VERSIONAL")).toEqual(["tenant:versional", "plain: and ", "tenant:VERSIONAL"]);
  });

  it("returns the whole text as one plain segment when nothing matches", () => {
    expect(kinds("Nothing to see here.")).toEqual(["plain:Nothing to see here."]);
  });

  it("gives an ambiguous name to us, never silently to a competitor", () => {
    // Same start, same length: without the kind tiebreak the winner depends on
    // the order competitors happen to come back from the database.
    const ambiguous: AnswerAlias[] = [
      { name: "Atlas", kind: "competitor", label: "Atlas Localization" },
      { name: "Atlas", kind: "tenant", label: "Atlas" },
    ];
    expect(kinds("Atlas is the one.", ambiguous)).toEqual(["tenant:Atlas", "plain: is the one."]);
  });

  it("drops an overlapping match rather than truncating it into a partial word", () => {
    // "Phrase TMS" wins from index 0; the bare "TMS" match that starts inside
    // it must be dropped whole, not clipped to a dangling "MS".
    const overlapping: AnswerAlias[] = [
      { name: "Phrase TMS", kind: "competitor", label: "Phrase" },
      { name: "TMS", kind: "competitor", label: "TMS Inc" },
    ];
    expect(kinds("Use Phrase TMS today.", overlapping)).toEqual([
      "plain:Use ",
      "competitor:Phrase TMS",
      "plain: today.",
    ]);
  });

  it("ignores an empty alias instead of marking every gap between characters", () => {
    expect(kinds("Versional is fine.", [{ name: "", kind: "competitor", label: "" }])).toEqual([
      "plain:Versional is fine.",
    ]);
  });

  it("marks a name at the very start and at the very end without inventing empty segments", () => {
    expect(kinds("Versional")).toEqual(["tenant:Versional"]);
    expect(kinds("Try Versional")).toEqual(["plain:Try ", "tenant:Versional"]);
  });

  it("marks a name touching punctuation — a full stop is not a word character", () => {
    expect(kinds("(Versional).")).toEqual(["plain:(", "tenant:Versional", "plain:)."]);
  });

  it("returns nothing at all for an empty answer", () => {
    expect(segmentAnswer("", ALIASES)).toEqual([]);
  });
});

describe("HighlightedAnswer", () => {
  it("marks us with the accent and a competitor with an outline", () => {
    const { container } = render(<HighlightedAnswer text="Versional or Lokalise" aliases={ALIASES} />);

    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(2);
    expect(marks[0].className).toContain("bg-brand-subtle");
    expect(marks[1].className).toContain("border");
    expect(marks[1].className).not.toContain("bg-brand-subtle");
  });

  it("renders markup in the answer as text, never as markup", () => {
    // The answer is text from a third-party API. It is rendered as React
    // children, never through dangerouslySetInnerHTML — this test is what
    // stops someone "simplifying" it into a string of <mark> tags later.
    const { container } = render(
      <HighlightedAnswer text={"<script>alert(1)</script> and <b>bold</b>"} aliases={ALIASES} />
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText(/<script>alert\(1\)<\/script> and <b>bold<\/b>/)).toBeInTheDocument();
  });

  it("names each mark for a screen reader, since colour is the only other cue", () => {
    render(<HighlightedAnswer text="Versional or Lokalise" aliases={ALIASES} />);

    expect(screen.getByText("Versional")).toHaveAttribute("title", "Versional (you)");
    expect(screen.getByText("Lokalise")).toHaveAttribute("title", "Lokalise (competitor)");
  });
});
