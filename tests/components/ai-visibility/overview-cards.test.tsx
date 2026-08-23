import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { EngineMetrics } from "../../../src/lib/ai-visibility/types";
import {
  OverviewCards,
  tileReading,
  type EngineTile,
} from "../../../src/app/(dashboard)/ai-visibility/overview-cards";
import { ratePct } from "../../../src/app/(dashboard)/ai-visibility/format";
import { engineGridClass } from "../../../src/app/(dashboard)/ai-visibility/engine-grid";
import { RunNowButton, estimateSentence } from "../../../src/app/(dashboard)/ai-visibility/run-now-button";
import { GeneratePromptSetButton } from "../../../src/app/(dashboard)/ai-visibility/generate-prompt-set-button";

const { refresh, push, toast, runNowAction, generatePromptSetAction } = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  runNowAction: vi.fn<() => Promise<{ ok: boolean; runId?: string; error?: string }>>(async () => ({
    ok: true,
    runId: "run-1",
  })),
  generatePromptSetAction: vi.fn<() => Promise<{ ok: boolean; proposed?: number; error?: string }>>(async () => ({
    ok: true,
    proposed: 30,
  })),
}));

const { router } = vi.hoisted(() => ({ router: {} as Record<string, unknown> }));
router.refresh = refresh;
router.push = push;
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("sonner", () => ({ toast }));
vi.mock("../../../src/app/(dashboard)/ai-visibility/actions", () => ({
  runNowAction,
  generatePromptSetAction,
}));

beforeEach(() => vi.clearAllMocks());

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

const ESTIMATE = { prompts: 5, engines: 3, samples: 3, calls: 45, usd: 6.23 };

function metrics(overrides: Partial<EngineMetrics> = {}): EngineMetrics {
  // Every rate is 0..100, not 0..1 — `engineMetrics` returns percentages
  // for all four, matching how the contract annotated shareOfVoice.
  return {
    engine: "openai",
    n: 84,
    mentionRate: 62,
    shareOfVoice: 31,
    citationRate: 18,
    recommendationRate: 24,
    mentionWilsonPp: 7,
    sovWilsonPp: 5,
    deltaPp: 3,
    ...overrides,
  };
}

function tile(overrides: Partial<EngineTile> = {}): EngineTile {
  return {
    engine: "openai",
    label: "ChatGPT API + web search",
    metrics: metrics(),
    failureNote: null,
    modelChangeNote: null,
    ...overrides,
  };
}

describe("tileReading", () => {
  it("headlines the MENTION rate with its own band, not the share of voice", () => {
    // Job 1 in the design is "know if we are being named". Share of voice does
    // not answer it, moves when a competitor is typed into settings, and reads
    // 100% for a tenant named once in 84 answers with nobody named beside it.
    // The band is `mentionWilsonPp`, which describes THIS number — a band
    // computed from the share would be mislabelled sitting here.
    expect(tileReading(metrics())).toEqual({
      kind: "rate",
      headline: "62%",
      band: "±7 pp",
    });
  });

  it("says Collecting baseline below the display threshold, never 0%", () => {
    // The one substitution the whole metrics design exists to prevent: an
    // engine with 11 answers reading as a real 0%. Below the threshold EVERY
    // rate is null, `mentionRate` included — which is what makes it the field
    // to test.
    expect(
      tileReading(
        metrics({
          n: 11,
          mentionRate: null,
          shareOfVoice: null,
          citationRate: null,
          recommendationRate: null,
          mentionWilsonPp: null,
          sovWilsonPp: null,
          deltaPp: null,
        })
      )
    ).toEqual({ kind: "baseline", headline: "Collecting baseline", band: null });
  });

  it("prints a measured zero as a rate with a band, because 0 of 84 is a reading", () => {
    // The old headline had to say "No brands named" here, because a share with
    // no denominator has no number at all. A mention rate always has one.
    expect(
      tileReading(metrics({ mentionRate: 0, shareOfVoice: null, mentionWilsonPp: 4, sovWilsonPp: null }))
    ).toEqual({ kind: "rate", headline: "0%", band: "±4 pp" });
  });

  it("keeps the band, which is the reading the number cannot be checked without", () => {
    expect(tileReading(metrics({ mentionWilsonPp: 9 })).band).toBe("±9 pp");
    expect(tileReading(metrics({ mentionWilsonPp: null })).band).toBeNull();
  });

  it("never prints the share band beside the mention headline", () => {
    // The failure this rename exists to prevent: ±5 pp is the width of the
    // SHARE, and printing it next to a mention rate labels the wrong number.
    expect(tileReading(metrics({ mentionWilsonPp: 7, sovWilsonPp: 5 })).band).toBe("±7 pp");
  });

  it("does not multiply an already-percentage rate", () => {
    // `engineMetrics` hands these over as 0..100. A stray ×100 here reads as
    // "6200%", which is obvious — and as "0%" for a rate of 0.4, which is not.
    expect(tileReading(metrics({ mentionRate: 0.4 })).headline).toBe("0%");
  });
});

describe("ratePct", () => {
  it("rounds an already-percentage rate and appends a sign, never multiplying again", () => {
    expect(ratePct(62)).toBe("62%");
    expect(ratePct(0.4)).toBe("0%");
    expect(ratePct(0)).toBe("0%");
  });

  it("prints one em dash for an unknown, so no call site can render it as a zero", () => {
    // The substitution the whole metrics design exists to prevent, now with a
    // single place it could ever go wrong. The four call sites that used to
    // hand-roll this were split between `Math.round`, `toFixed(0)` and their
    // own null branches — one of which did not have one.
    expect(ratePct(null)).toBe("—");
  });
});

describe("OverviewCards", () => {
  it("prints the sample count on every tile — a rate without one is unreadable", () => {
    render(<OverviewCards tiles={[tile(), tile({ engine: "all", label: "All engines" })]} />);

    // Plain words, not "n = 84 answers": the header two hundred pixels above
    // counts something else ("252 calls", errors included) and the algebraic
    // prefix made the smaller number look like the authoritative one.
    expect(screen.getAllByText("84 answers read")).toHaveLength(2);
  });

  it("carries no Share of voice / Cited / Recommended line", () => {
    // Twelve numbers in the page's densest row, three em dashes joined by
    // interpuncts in the baseline state, and a share of voice the benchmark
    // card below states twice more. The metrics stay on `EngineMetrics`;
    // citation rate is stated once on the Cited-sources card, beside the
    // denominator it is actually measured over.
    render(<OverviewCards tiles={[tile()]} />);

    expect(screen.queryByText(/Share of voice/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cited/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Recommended/)).not.toBeInTheDocument();
  });

  it("titles the tile with the short engine name and keeps the full one as its tooltip", () => {
    // "ChatGPT API + web search" is ~180px of methodology in a header that
    // truncates at about half that. The "API-observed" badge in the page
    // header carries the proxy caveat once, with the tooltip that explains it.
    render(<OverviewCards tiles={[tile({ label: "ChatGPT" })]} />);

    expect(screen.getByText("ChatGPT")).toHaveAttribute("title", "ChatGPT API + web search");
  });

  it("draws no sparkline of its own — the trend is one chart beneath the row", () => {
    // Four tiles each drew the same metric over the same window, all pinned to
    // the same 0..100 domain, at 64px with both axes hidden. One fact, four
    // objects, none of them big enough to read a direction off.
    const { container } = render(
      <OverviewCards tiles={[tile(), tile({ engine: "all", label: "All engines" })]} />
    );

    expect(container.querySelector("svg.recharts-surface")).toBeNull();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("keeps printing n on a below-threshold tile, so the reader can watch it grow", () => {
    render(
      <OverviewCards
        tiles={[
          tile({
            metrics: metrics({
              n: 11,
              mentionRate: null,
              shareOfVoice: null,
              citationRate: null,
              recommendationRate: null,
              mentionWilsonPp: null,
          sovWilsonPp: null,
              deltaPp: null,
            }),
          }),
        ]}
      />
    );

    expect(screen.getByText("Collecting baseline")).toBeInTheDocument();
    expect(screen.getByText("11 answers read")).toBeInTheDocument();
    expect(screen.queryByText(/pp$/)).not.toBeInTheDocument();
  });

  it("still prints a measured zero as a rate, not as a sentence", () => {
    // 0 of 84 is a reading, and it has a band. "Collecting baseline" is
    // reserved for the window that is too thin to say anything at all — the
    // one distinction this whole surface is arranged to keep.
    const noneNamed = metrics({ mentionRate: 0, shareOfVoice: null, mentionWilsonPp: 4, sovWilsonPp: null });
    render(<OverviewCards tiles={[tile({ metrics: noneNamed })]} />);

    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.getByText("±4 pp")).toBeInTheDocument();
    expect(screen.queryByText("Collecting baseline")).not.toBeInTheDocument();
  });

  it("prints no 30-day delta line, whatever deltaPp says", () => {
    render(<OverviewCards tiles={[tile({ metrics: metrics({ deltaPp: 3 }) })]} />);

    expect(screen.queryByText(/30 days ago/)).not.toBeInTheDocument();
    // The band survives the cut — it is the one number that qualifies the
    // headline rather than narrating it, and it is the MENTION band.
    expect(screen.getByText("±7 pp")).toBeInTheDocument();
    expect(screen.queryByText("±5 pp")).not.toBeInTheDocument();
  });

  it("lays the row out for the tiles it actually has", () => {
    const { container, rerender } = render(
      <OverviewCards tiles={[tile(), tile({ engine: "all", label: "All engines" })]} />
    );
    expect(container.firstElementChild!.className).toBe("grid gap-3 sm:grid-cols-2");

    rerender(
      <OverviewCards
        tiles={[
          tile(),
          tile({ engine: "gemini", label: "Gemini API, grounded" }),
          tile({ engine: "anthropic", label: "Claude API + web search" }),
          tile({ engine: "all", label: "All engines" }),
        ]}
      />
    );
    expect(container.firstElementChild!.className).toBe("grid gap-3 sm:grid-cols-2 xl:grid-cols-4");
  });

  it("prints a partial failure in the destructive tone, not as a muted aside", () => {
    render(<OverviewCards tiles={[tile({ failureNote: "Gemini API, grounded failed on 9 prompts — rate limited" })]} />);

    const note = screen.getByText("Gemini API, grounded failed on 9 prompts — rate limited");
    expect(note.className).toContain("text-destructive");
  });

  it("notes a model change under the tile so a jump is not misread", () => {
    render(<OverviewCards tiles={[tile({ modelChangeNote: "Model changed to gpt-5.2-2026-07-01 this run" })]} />);

    expect(screen.getByText("Model changed to gpt-5.2-2026-07-01 this run")).toBeInTheDocument();
  });
});

describe("engineGridClass", () => {
  it("sizes for the row it is given, not for the most engines anyone could enable", () => {
    // A tenant with one engine on shows two tiles and one with three shows
    // four; the old `xl:grid-cols-5` was cut for a four-engine world that
    // ended when Perplexity was removed, and left every tenant an empty
    // trailing column.
    expect(engineGridClass(2)).toBe("grid gap-3 sm:grid-cols-2");
    expect(engineGridClass(3)).toBe("grid gap-3 sm:grid-cols-2 xl:grid-cols-3");
    expect(engineGridClass(4)).toBe("grid gap-3 sm:grid-cols-2 xl:grid-cols-4");
  });

  it("gives a lone card the full row, and an unexpected count the widest one", () => {
    expect(engineGridClass(1)).toBe("grid gap-3");
    expect(engineGridClass(7)).toBe("grid gap-3 sm:grid-cols-2 xl:grid-cols-4");
  });
});

describe("estimateSentence", () => {
  it("states the shape of the spend in plain dollars, never credits", () => {
    expect(estimateSentence({ prompts: 5, engines: 3, samples: 3, calls: 45, usd: 6.23 })).toBe(
      "≈ 45 calls — 5 prompts × 3 engines × up to 3 samples — about $6.23"
    );
  });

  it("quotes the planned CALL count rather than a product the reader can falsify", () => {
    // Two brand-check prompts among the five: they are sampled once per engine,
    // so the plan is 3×3×3 + 2×3 = 33 calls, not the 45 that 5 × 3 × 3 implies.
    // The old sentence invited exactly that multiplication and lost the
    // argument — it read "≈ 26 prompts × 3 engines × 3 samples" over a plan of
    // 216 calls, not the 234 it spelled out.
    expect(estimateSentence({ prompts: 5, engines: 3, samples: 3, calls: 33, usd: 4.57 })).toContain(
      "≈ 33 calls"
    );
  });
});

describe("RunNowButton", () => {
  it("is disabled with a visible reason rather than silently inert", () => {
    render(
      <RunNowButton
        estimate={{ prompts: 28, engines: 3, samples: 3, calls: 252, usd: 3.12 }}
        disabledReason="A run is already in progress."
      />
    );

    expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled();
    expect(screen.getByText("A run is already in progress.")).toBeInTheDocument();
  });

  it("reserves the error tone for the cap — a run in progress is not a failure", () => {
    const { rerender } = render(
      <RunNowButton
        estimate={{ prompts: 28, engines: 3, samples: 3, calls: 252, usd: 3.12 }}
        disabledReason="Running… 41 / 270 calls"
        disabledTone="muted"
      />
    );
    expect(screen.getByText("Running… 41 / 270 calls").className).toContain("text-muted-foreground");

    rerender(
      <RunNowButton
        estimate={{ prompts: 28, engines: 3, samples: 3, calls: 252, usd: 3.12 }}
        disabledReason="Paused — monthly cap reached ($20.00 of $20.00)."
        disabledTone="destructive"
      />
    );
    expect(screen.getByText("Paused — monthly cap reached ($20.00 of $20.00).").className).toContain(
      "text-destructive"
    );
  });

  it("takes its label from the caller, so the post-approval CTA can differ", () => {
    render(
      <RunNowButton
        estimate={{ prompts: 28, engines: 3, samples: 3, calls: 252, usd: 3.12 }}
        disabledReason={null}
        label="Run first audit now"
      />
    );

    expect(screen.getByRole("button", { name: "Run first audit now" })).toBeInTheDocument();
  });

  it("never starts a run straight off the click — the cost is confirmed first", async () => {
    render(<RunNowButton estimate={ESTIMATE} disabledReason={null} />);

    await click(screen.getByRole("button", { name: "Run now" }));

    expect(runNowAction).not.toHaveBeenCalled();
    expect(
      screen.getByText(/≈ \d+ calls — .* — about \$\d/)
    ).toBeInTheDocument();
    // The attribution-lag caveat travels with the spend, per the trust cues.
    expect(screen.getByText(/Content changes show in 60–90 days\./)).toBeInTheDocument();
  });

  it("starts the run on confirmation and refreshes, so the header swaps to Running", async () => {
    render(<RunNowButton estimate={ESTIMATE} disabledReason={null} />);
    await click(screen.getByRole("button", { name: "Run now" }));

    const confirm = screen.getAllByRole("button", { name: "Run now" }).at(-1)!;
    await click(confirm);

    expect(runNowAction).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Run started");
  });

  it("reports a refusal as a toast and leaves the dialog open to try again", async () => {
    runNowAction.mockResolvedValueOnce({ ok: false, error: "A run is already in progress." });
    render(<RunNowButton estimate={ESTIMATE} disabledReason={null} />);
    await click(screen.getByRole("button", { name: "Run now" }));
    await click(screen.getAllByRole("button", { name: "Run now" }).at(-1)!);

    expect(toast.error).toHaveBeenCalledWith("A run is already in progress.");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("offers no dialog at all while disabled — the reason is the whole answer", async () => {
    render(<RunNowButton estimate={ESTIMATE} disabledReason="Paused — monthly cap reached." />);

    await click(screen.getByRole("button", { name: "Run now" }));
    expect(screen.queryByText(/≈ 28 prompts/)).not.toBeInTheDocument();
    expect(runNowAction).not.toHaveBeenCalled();
  });
});

describe("GeneratePromptSetButton", () => {
  it("drafts, then sends the reviewer to the prompts page", async () => {
    render(<GeneratePromptSetButton disabledReason={null} />);

    await click(screen.getByRole("button", { name: "Generate prompt set" }));

    expect(generatePromptSetAction).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("30 prompts drafted — review them");
    expect(push).toHaveBeenCalledWith("/ai-visibility/prompts");
  });

  it("leaves the surface exactly as it was on failure, so the retry is the same button", async () => {
    generatePromptSetAction.mockResolvedValueOnce({ ok: false, error: "Couldn't draft prompts just now — try again." });
    render(<GeneratePromptSetButton disabledReason={null} />);

    await click(screen.getByRole("button", { name: "Generate prompt set" }));

    expect(toast.error).toHaveBeenCalledWith("Couldn't draft prompts just now — try again.");
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Generate prompt set" })).toBeInTheDocument();
  });

  it("states the reason next to a disabled control rather than only on hover", async () => {
    render(<GeneratePromptSetButton disabledReason="Add a category and positioning on Company first." />);

    expect(screen.getByRole("button", { name: "Generate prompt set" })).toBeDisabled();
    expect(screen.getByText("Add a category and positioning on Company first.")).toBeInTheDocument();
    await click(screen.getByRole("button", { name: "Generate prompt set" }));
    expect(generatePromptSetAction).not.toHaveBeenCalled();
  });

  it("takes the outline variant where it shares a row with a primary action", () => {
    // One accent-filled button per screen region: two chartreuse buttons side
    // by side means one of them is not actually primary.
    render(<GeneratePromptSetButton disabledReason={null} label="Suggest more" variant="outline" />);

    const button = screen.getByRole("button", { name: "Suggest more" });
    expect(button.className).not.toContain("bg-primary");
  });
});
