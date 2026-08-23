import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { EngineId } from "../../../src/lib/ai-visibility/types";
import {
  EngineTabs,
  type SampleView,
} from "../../../src/app/(dashboard)/ai-visibility/prompts/[promptId]/engine-tabs";
import type { AnswerAlias } from "../../../src/app/(dashboard)/ai-visibility/prompts/[promptId]/highlighted-answer";

const ALIASES: AnswerAlias[] = [
  { name: "Versional", kind: "tenant", label: "Versional" },
  { name: "Acme", kind: "competitor", label: "Acme" },
];

function sample(overrides: Partial<SampleView> = {}): SampleView {
  return {
    id: "s1",
    engine: "openai",
    sampleIndex: 0,
    askedAtLabel: "Aug 17, 2026",
    modelId: "gpt-5.2",
    status: "ok",
    answerText: "Versional and Acme both work well for design teams.",
    framing: null,
    level: "mentioned",
    flagged: false,
    error: null,
    citations: [],
    ...overrides,
  };
}

function tabs(samples: SampleView[], engines: EngineId[] = ["openai"], initial: EngineId = "openai") {
  return render(
    <EngineTabs engines={engines} samples={samples} aliases={ALIASES} initialEngine={initial} />
  );
}

describe("EngineTabs — the tab strip", () => {
  it("opens the engine the caller asked for, not the first one", () => {
    tabs([sample({ engine: "gemini", id: "g1", answerText: "Gemini said this." })], ["openai", "gemini"], "gemini");

    expect(screen.getByText("Gemini said this.")).toBeInTheDocument();
  });

  it("shows one tab per engine the tenant runs, short label with the full one on hover", () => {
    tabs([], ["openai", "anthropic"], "openai");

    expect(screen.getByRole("tab", { name: "GPT" })).toHaveAttribute("title", "GPT-5.x API + web search");
    expect(screen.getByRole("tab", { name: "Claude" })).toHaveAttribute("title", "Claude API + web search");
    expect(screen.queryByRole("tab", { name: "Gem" })).not.toBeInTheDocument();
  });

  it("names the engine in the empty message rather than saying 'no answers' with no subject", () => {
    tabs([], ["openai"], "openai");

    expect(screen.getByText("No answers from GPT-5.x API + web search yet.")).toBeInTheDocument();
  });

  it("keeps each engine's answers in its own tab", () => {
    const { container } = tabs(
      [
        sample({ id: "a", engine: "openai", answerText: "From GPT." }),
        sample({ id: "b", engine: "gemini", answerText: "From Gemini." }),
      ],
      ["openai", "gemini"],
      "openai"
    );

    expect(screen.getByText("From GPT.")).toBeInTheDocument();
    // The inactive tab's panel is either unmounted or hidden — either way its
    // answer must not read as GPT's.
    const activePanel = container.querySelector('[role="tabpanel"]:not([hidden])')!;
    expect(within(activePanel as HTMLElement).queryByText("From Gemini.")).toBeNull();
  });
});

describe("EngineTabs — a sample's status", () => {
  it("shows a pending row as waiting, NOT as an error — planRun inserts the whole grid up front", () => {
    // During a run most rows have simply not been asked yet. Badging them
    // "Error" reports a healthy in-flight run as a broken one, on the page a
    // human opens precisely to watch it.
    tabs([sample({ status: "pending", answerText: "", modelId: null, level: null })]);

    expect(screen.getByText("Waiting for this engine.")).toBeInTheDocument();
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
    expect(screen.queryByText("Refused")).not.toBeInTheDocument();
  });

  it("badges an errored row and prints the provider's own reason in the destructive tone", () => {
    tabs([sample({ status: "error", answerText: "", error: "429 rate limited", level: null })]);

    expect(screen.getByText("Error")).toBeInTheDocument();
    const reason = screen.getByText("429 rate limited");
    expect(reason.className).toContain("text-destructive");
  });

  it("says an errored row is excluded when the provider gave no reason, rather than showing a blank body", () => {
    tabs([sample({ status: "error", answerText: "", error: null, level: null })]);

    expect(screen.getByText("No answer — excluded from every rate on this page.")).toBeInTheDocument();
  });

  it("distinguishes a refusal from an error — declining to search is not a failure of ours", () => {
    tabs([sample({ status: "refused", answerText: "", error: "declined to search", level: null })]);

    expect(screen.getByText("Refused")).toBeInTheDocument();
    expect(screen.queryByText("Error")).not.toBeInTheDocument();
  });

  it("gives a flagged sample the stale treatment and says why it is excluded", () => {
    const { container } = tabs([sample({ flagged: true })]);

    expect(screen.getByText("Excluded — checks disagreed")).toBeInTheDocument();
    expect(container.querySelector("li")!.className).toContain("dashed-outline");
    expect(container.querySelector("li")!.className).toContain("opacity-85");
  });

  it("leaves a clean sample undecorated", () => {
    const { container } = tabs([sample()]);

    expect(container.querySelector("li")!.className).not.toContain("dashed-outline");
    expect(screen.queryByText("Excluded — checks disagreed")).not.toBeInTheDocument();
  });
});

describe("EngineTabs — a sample's body", () => {
  it("names the level in words, since the highlight alone cannot say 'recommended'", () => {
    tabs([sample({ level: "recommended" })]);

    expect(screen.getByText("Recommended")).toBeInTheDocument();
  });

  it("prints no level badge for a sample the judge never labelled", () => {
    tabs([sample({ level: null })]);

    for (const label of ["Not named", "Mentioned", "Described", "Recommended"]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it("numbers the sample from one and carries its date and model id", () => {
    tabs([sample({ sampleIndex: 2 })]);

    expect(screen.getByText("Sample 3")).toBeInTheDocument();
    expect(screen.getByText("Aug 17, 2026")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.2")).toBeInTheDocument();
  });

  it("highlights us and outlines a competitor inside the answer", () => {
    const { container } = tabs([sample()]);

    const marks = [...container.querySelectorAll("mark")];
    expect(marks.map((mark) => mark.textContent)).toEqual(["Versional", "Acme"]);
    expect(marks[0].className).toContain("bg-brand-subtle");
    expect(marks[1].className).not.toContain("bg-brand-subtle");
  });

  it("clamps a long answer and expands it in place rather than truncating it", () => {
    const { container } = tabs([sample()]);

    // A height clamp, not `line-clamp`: the answer renders as markdown — a
    // block of headings and lists — and -webkit-box line clamping only ever
    // clamped the single text node it used to be.
    const answer = container.querySelector(".answer-content")!;
    expect(answer.className).toContain("max-h-64");
    expect(answer.className).toContain("overflow-hidden");

    fireEvent.click(screen.getByRole("button", { name: "Show full answer" }));
    expect(container.querySelector(".answer-content")!.className).not.toContain("max-h-64");
    expect(screen.getByRole("button", { name: "Show less" })).toBeInTheDocument();
  });

  it("offers no expander on a row with no answer to expand", () => {
    tabs([sample({ status: "error", answerText: "", error: "boom", level: null })]);

    expect(screen.queryByRole("button", { name: "Show full answer" })).not.toBeInTheDocument();
  });

  it("carries the judge's framing line under the answer", () => {
    tabs([sample({ framing: "Named as the budget option." })]);

    expect(screen.getByText("Named as the budget option.")).toBeInTheDocument();
  });

  it("lists citations in order, opening off-site safely", () => {
    tabs([
      sample({
        citations: [
          { url: "https://g2.com/a", domain: "g2.com", domainClass: "third_party" },
          { url: "https://acme.com/b", domain: "acme.com", domainClass: "competitor" },
        ],
      }),
    ]);

    const first = screen.getByRole("link", { name: "1. g2.com" });
    expect(first).toHaveAttribute("href", "https://g2.com/a");
    expect(first).toHaveAttribute("target", "_blank");
    // Without noopener the opened page gets a handle on this one.
    expect(first).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "2. acme.com" })).toBeInTheDocument();
  });

  it("renders no citation list at all when there were none", () => {
    const { container } = tabs([sample({ citations: [] })]);

    expect(container.querySelectorAll("a[target='_blank']")).toHaveLength(0);
  });
});
