import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EngineMetrics } from "../../../src/lib/ai-visibility/types";
import {
  OverviewCards,
  metricsLine,
  tileReading,
  type EngineTile,
} from "../../../src/app/(dashboard)/ai-visibility/overview-cards";
import { RunNowButton, estimateSentence } from "../../../src/app/(dashboard)/ai-visibility/run-now-button";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../../src/app/(dashboard)/ai-visibility/actions", () => ({
  runNowAction: vi.fn(async () => ({ ok: true as const, runId: "run-1" })),
}));

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
  it("reads the headline, the Wilson band and the muted 30-day delta", () => {
    expect(tileReading(metrics())).toEqual({
      headline: "31%",
      band: "±5 pp",
      delta: "+3 pp vs 30 days ago",
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
    ).toEqual({ headline: "Collecting baseline", band: null, delta: null });
  });

  it("distinguishes a MEASURED zero from a thin cut — 84 answers naming nobody is a finding, not missing data", () => {
    // `shareOfVoice === null` means two things: below the threshold, and
    // "n >= 30 but no tracked brand was named at all". Branching on it would
    // tell a tenant with 84 collected answers that their data is still coming
    // in, which is false and hides the most actionable state on the page.
    expect(tileReading(metrics({ mentionRate: 0, shareOfVoice: null, wilsonPp: null, deltaPp: null }))).toEqual({
      headline: "No brands named",
      band: null,
      delta: null,
    });
  });

  it("omits the delta when there is no 30-day-ago window to compare against", () => {
    expect(tileReading(metrics({ deltaPp: null })).delta).toBeNull();
  });

  it("writes a fall with a real minus sign, not a hyphen", () => {
    expect(tileReading(metrics({ deltaPp: -2 })).delta).toBe("−2 pp vs 30 days ago");
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

  it("keeps the delta muted and uncoloured, per the attribution-lag rule", () => {
    render(<OverviewCards tiles={[tile()]} />);

    const delta = screen.getByText("+3 pp vs 30 days ago");
    expect(delta.className).toContain("text-muted-foreground");
    expect(delta.className).not.toContain("text-destructive");
    expect(delta.className).not.toContain("brand");
  });

  it("prints a partial failure in the destructive tone, not as a muted aside", () => {
    render(<OverviewCards tiles={[tile({ failureNote: "Perplexity failed on 9 prompts — rate limited" })]} />);

    const note = screen.getByText("Perplexity failed on 9 prompts — rate limited");
    expect(note.className).toContain("text-destructive");
  });

  it("notes a model change under the tile so a jump is not misread", () => {
    render(<OverviewCards tiles={[tile({ modelChangeNote: "Model changed to gpt-5.2-2026-07-01 this run" })]} />);

    expect(screen.getByText("Model changed to gpt-5.2-2026-07-01 this run")).toBeInTheDocument();
  });
});

describe("estimateSentence", () => {
  it("states the shape of the spend in plain dollars, never credits", () => {
    expect(estimateSentence({ prompts: 28, engines: 4, samples: 3, calls: 336, usd: 3.12 })).toBe(
      "≈ 28 prompts × 4 engines × 3 samples — about $3.12"
    );
  });
});

describe("RunNowButton", () => {
  it("is disabled with a visible reason rather than silently inert", () => {
    render(
      <RunNowButton
        estimate={{ prompts: 28, engines: 4, samples: 3, calls: 336, usd: 3.12 }}
        disabledReason="A run is already in progress."
      />
    );

    expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled();
    expect(screen.getByText("A run is already in progress.")).toBeInTheDocument();
  });

  it("takes its label from the caller, so the post-approval CTA can differ", () => {
    render(
      <RunNowButton
        estimate={{ prompts: 28, engines: 4, samples: 3, calls: 336, usd: 3.12 }}
        disabledReason={null}
        label="Run first audit now"
      />
    );

    expect(screen.getByRole("button", { name: "Run first audit now" })).toBeInTheDocument();
  });
});
