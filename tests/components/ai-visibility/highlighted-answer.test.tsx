import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  HighlightedAnswer,
  answerHtml,
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

describe("answerHtml", () => {
  it("renders the markdown an engine actually writes — headings, lists, bold", () => {
    // A real answer opens like this. Rendered as plain text it showed the
    // marketer `##` and `**` in the one place they go to understand a number.
    const html = answerHtml("## 1. Tools\n\n- **Versional** — a content hub\n- Lokalise\n", ALIASES);

    expect(html).toContain("<h2>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>");
    expect(html).not.toContain("##");
    expect(html).not.toContain("**");
  });

  it("marks a brand in ordinary prose, us in the accent and a rival outlined", () => {
    const html = answerHtml("Try Versional or Lokalise.", ALIASES);

    expect(html).toContain('<mark title="Versional (you)" class="rounded-sm px-0.5 bg-brand-subtle');
    expect(html).toContain('<mark title="Lokalise (competitor)"');
  });

  it("marks a brand inside a heading and inside a list item, not only in a paragraph", () => {
    const html = answerHtml("## Versional\n\n- Lokalise is another\n", ALIASES);

    expect(html).toMatch(/<h2><mark title="Versional \(you\)"/);
    expect(html).toMatch(/<li><mark title="Lokalise \(competitor\)"/);
  });

  it("renders raw HTML in the answer inert — no script, no event handler, no tag", () => {
    // The answer is text from a third-party API. `renderMarkdown` drops raw
    // HTML outright; nothing here re-introduces it.
    const html = answerHtml('<script>alert(1)</script> <img src=x onerror="alert(1)"> ok', ALIASES);

    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<img");
  });

  it("escapes the brand name it marks, so an alias cannot smuggle markup either", () => {
    const html = answerHtml("<b>Versional</b> ships", ALIASES);

    expect(html).not.toContain("<b>");
    expect(html).toContain("<mark");
  });

  it("does not mark an alias inside a link's href", () => {
    // The href never reaches the matcher at all — only text tokens do — which
    // is the property that makes this safe rather than lucky.
    const html = answerHtml("[the docs](https://lokalise.com/pricing) explain it", ALIASES);

    expect(html).toContain('href="https://lokalise.com/pricing"');
    expect(html).not.toMatch(/href="[^"]*<mark/);
    expect(html).not.toContain("<mark");
  });

  it("does not mark an alias inside a code span or a fenced block", () => {
    const inline = answerHtml("Run `Versional deploy` to ship", ALIASES);
    expect(inline).toContain("<code>Versional deploy</code>");
    expect(inline).not.toContain("<mark");

    const fenced = answerHtml("```\nimport Versional from 'x'\n```", ALIASES);
    expect(fenced).toContain("<pre>");
    expect(fenced).not.toContain("<mark");
  });

  it("still marks the same alias in the prose around the code", () => {
    const html = answerHtml("Versional ships `Versional deploy` daily", ALIASES);

    expect(html.match(/<mark/g)).toHaveLength(1);
  });

  it("keeps a blanked href blanked — the renderer's own guarantee, unchanged by marking", () => {
    expect(answerHtml("[click](javascript:alert(1))", ALIASES)).toContain('href=""');
  });

  it("does not mark a brand name inside a bare URL the way it never did in plain text", () => {
    const html = answerHtml("See https://lokalise.com/pricing for Lokalise pricing.", ALIASES);

    // One mark: the prose mention, not the autolinked URL.
    expect(html.match(/<mark/g)).toHaveLength(1);
  });

  it("escapes ordinary text exactly as the renderer would, entities included", () => {
    const html = answerHtml("5 < 6 & 7 &amp; 8", ALIASES);

    expect(html).toBe("<p>5 &lt; 6 &amp; 7 &amp; 8</p>");
  });

  it("returns nothing for an empty answer", () => {
    expect(answerHtml("", ALIASES)).toBe("");
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

  it("renders the answer's markdown structure rather than its source", () => {
    const { container } = render(
      <HighlightedAnswer text={"## Best tools\n\n- **Versional**\n- Lokalise\n"} aliases={ALIASES} />
    );

    expect(container.querySelector("h2")).toHaveTextContent("Best tools");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("strong")).toBeInTheDocument();
    expect(container.textContent).not.toContain("##");
  });

  it("renders markup in the answer inert, never as markup", () => {
    // The answer is text from a third-party API, and this component uses
    // dangerouslySetInnerHTML. What keeps that safe is that the HTML is built
    // by `renderMarkdown` — which drops raw HTML and blanks unsafe hrefs — and
    // that the marks go in at the text-token level, never by string-replacing
    // over rendered markup. This test is what stops someone "simplifying"
    // that into a replace over the rendered HTML.
    const { container } = render(
      <HighlightedAnswer text={"<script>alert(1)</script> and <b>bold</b>"} aliases={ALIASES} />
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.innerHTML).not.toContain("onerror");
  });

  it("names each mark for a screen reader, since colour is the only other cue", () => {
    render(<HighlightedAnswer text="Versional or Lokalise" aliases={ALIASES} />);

    expect(screen.getByText("Versional")).toHaveAttribute("title", "Versional (you)");
    expect(screen.getByText("Lokalise")).toHaveAttribute("title", "Lokalise (competitor)");
  });

  it("carries the styling the rendered markdown needs, since preflight flattens it", () => {
    const { container } = render(<HighlightedAnswer text="# Title" aliases={ALIASES} className="max-h-64" />);

    const root = container.firstElementChild!;
    expect(root.className).toContain("mdx-content");
    expect(root.className).toContain("answer-content");
    // And the caller's own class still lands — the clamp on the samples list.
    expect(root.className).toContain("max-h-64");
  });
});
