import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { EngineMetrics } from "../../../src/lib/ai-visibility/types";
import {
  OverviewCards,
  metricsLine,
  tileReading,
  type EngineTile,
} from "../../../src/app/(dashboard)/ai-visibility/overview-cards";
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

const ESTIMATE = { prompts: 28, engines: 3, samples: 3, calls: 252, usd: 3.12 };

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
    wilsonPp: 5,
    deltaPp: 3,
    ...overrides,
  };
}

function tile(overrides: Partial<EngineTile> = {}): EngineTile {
  return {
    engine: "openai",
    label: "GPT-5.x API + web search",
    metrics: metrics(),
    points: [],
    failureNote: null,
    modelChangeNote: null,
    ...overrides,
  };
}

describe("tileReading", () => {
  it("reads the headline and the Wilson band, and nothing about a 30-day delta", () => {
    // `deltaPp` is still on the metrics object — the tile just no longer
    // prints it. Overlapping windows damp it, and it is null until roughly
    // eight lifetime runs; the sparkline underneath carries the trend.
    expect(tileReading(metrics())).toEqual({
      kind: "share",
      headline: "31%",
      band: "±5 pp",
    });
  });

  it("says Collecting baseline below the display threshold, never 0%", () => {
    // The one substitution the whole metrics design exists to prevent: an
    // engine with 11 answers reading as a real 0% share. Below the threshold
    // EVERY rate is null, `mentionRate` included — which is what makes it the
    // field to test.
    expect(
      tileReading(
        metrics({
          n: 11,
          mentionRate: null,
          shareOfVoice: null,
          citationRate: null,
          recommendationRate: null,
          wilsonPp: null,
          deltaPp: null,
        })
      )
    ).toEqual({ kind: "baseline", headline: "Collecting baseline", band: null });
  });

  it("distinguishes a MEASURED zero from a thin cut — 84 answers naming nobody is a finding, not missing data", () => {
    // `shareOfVoice === null` means two things: below the threshold, and
    // "n >= 30 but no tracked brand was named at all". Branching on it would
    // tell a tenant with 84 collected answers that their data is still coming
    // in, which is false and hides the most actionable state on the page.
    expect(tileReading(metrics({ mentionRate: 0, shareOfVoice: null, wilsonPp: null, deltaPp: null }))).toEqual({
      kind: "measured-zero",
      headline: "No brands named",
      band: null,
    });
  });

  it("keeps the band, which is the reading the number cannot be checked without", () => {
    expect(tileReading(metrics({ wilsonPp: 9 })).band).toBe("±9 pp");
    expect(tileReading(metrics({ wilsonPp: null })).band).toBeNull();
  });
});

describe("metricsLine", () => {
  it("carries the other three metrics on one line", () => {
    expect(metricsLine(metrics())).toBe("Mentioned 62% · Cited 18% · Recommended 24%");
  });

  it("dashes a metric that is below threshold rather than printing a zero", () => {
    expect(metricsLine(metrics({ citationRate: null }))).toBe("Mentioned 62% · Cited — · Recommended 24%");
  });

  it("does not multiply an already-percentage rate", () => {
    // `engineMetrics` hands these over as 0..100. A stray ×100 here reads as
    // "Mentioned 6200%", which is obvious — and as "Mentioned 0%" for a rate
    // of 0.4, which is not.
    expect(metricsLine(metrics({ mentionRate: 0.4 }))).toContain("Mentioned 0%");
  });
});

describe("OverviewCards", () => {
  it("prints n on every tile — a share without one is unreadable", () => {
    render(<OverviewCards tiles={[tile(), tile({ engine: "all", label: "All engines" })]} />);

    expect(screen.getAllByText("n = 84 answers")).toHaveLength(2);
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
              wilsonPp: null,
              deltaPp: null,
            }),
          }),
        ]}
      />
    );

    expect(screen.getByText("Collecting baseline")).toBeInTheDocument();
    expect(screen.getByText("n = 11 answers")).toBeInTheDocument();
    expect(screen.queryByText(/pp$/)).not.toBeInTheDocument();
  });

  it("renders a measured zero differently from a thin cut — both are bandless, only one is a finding", () => {
    const baseline = metrics({
      n: 11,
      mentionRate: null,
      shareOfVoice: null,
      citationRate: null,
      recommendationRate: null,
      wilsonPp: null,
      deltaPp: null,
    });
    const measuredZero = metrics({ mentionRate: 0, shareOfVoice: null, wilsonPp: null, deltaPp: null });
    const { rerender } = render(<OverviewCards tiles={[tile({ metrics: baseline })]} />);
    const baselineClass = screen.getByText("Collecting baseline").className;

    rerender(<OverviewCards tiles={[tile({ metrics: measuredZero })]} />);
    const findingClass = screen.getByText("No brands named").className;

    expect(baselineClass).toContain("text-muted-foreground");
    expect(findingClass).not.toContain("text-muted-foreground");
    expect(findingClass).toContain("text-foreground");
  });

  it("prints no 30-day delta line, whatever deltaPp says", () => {
    render(<OverviewCards tiles={[tile({ metrics: metrics({ deltaPp: 3 }) })]} />);

    expect(screen.queryByText(/30 days ago/)).not.toBeInTheDocument();
    // The band survives the cut — it is the one number that qualifies the
    // headline rather than narrating it.
    expect(screen.getByText("±5 pp")).toBeInTheDocument();
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
    expect(estimateSentence({ prompts: 28, engines: 3, samples: 3, calls: 252, usd: 3.12 })).toBe(
      "≈ 28 prompts × 3 engines × 3 samples — about $3.12"
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
      screen.getByText(/≈ 28 prompts × 3 engines × 3 samples — about \$3\.12/)
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
