import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { EngineId } from "../../../src/lib/ai-visibility/types";
import {
  MATRIX_INITIAL_ROWS,
  PromptMatrix,
  cellReading,
  type MatrixRow,
} from "../../../src/app/(dashboard)/ai-visibility/prompt-matrix";

function cells(named: number | null, samples = 3): MatrixRow["cells"] {
  const entry = { named, samples, failed: false };
  return { openai: entry, gemini: entry, anthropic: entry } as Record<
    EngineId,
    { named: number | null; samples: number; failed: boolean }
  >;
}

function row(index: number, overrides: Partial<MatrixRow> = {}): MatrixRow {
  return {
    promptId: `p${index}`,
    text: `best localization tools ${index}`,
    branded: false,
    cells: cells(2),
    ...overrides,
  };
}

describe("cellReading", () => {
  it("counts samples — never a boolean", () => {
    // "2 of 3" is the entire point: a yes/no cell throws away the only
    // signal that distinguishes a stable mention from a coin flip.
    expect(cellReading({ named: 2, samples: 3, failed: false })).toEqual({ text: "2/3", tone: "partial" });
    expect(cellReading({ named: 3, samples: 3, failed: false })).toEqual({ text: "3/3", tone: "full" });
    expect(cellReading({ named: 0, samples: 3, failed: false })).toEqual({ text: "0/3", tone: "absent" });
  });

  it("shows a dash for an engine that failed, so the gap is not read as a zero", () => {
    expect(cellReading({ named: null, samples: 0, failed: true })).toEqual({
      text: "–",
      tone: "unavailable",
    });
  });

  it("shows a dash below the per-prompt threshold of three samples", () => {
    expect(cellReading({ named: 1, samples: 2, failed: false }).tone).toBe("unavailable");
  });

  it("dashes an engine that was never asked, rather than reporting 0 of 0", () => {
    // `named: null` is "no cut exists", which the page produces for an engine
    // this prompt has no aggregate row for at all.
    expect(cellReading({ named: null, samples: 0, failed: false })).toEqual({
      text: "–",
      tone: "unavailable",
    });
  });

  it("dashes a failed engine even when a countable cut exists — the run is not trustworthy", () => {
    expect(cellReading({ named: 3, samples: 3, failed: true }).tone).toBe("unavailable");
  });
});

describe("PromptMatrix", () => {
  it("shows 20 rows and offers the rest in place", () => {
    const rows = Array.from({ length: 28 }, (_, index) => row(index));
    render(<PromptMatrix rows={rows} />);

    expect(screen.getAllByRole("row")).toHaveLength(MATRIX_INITIAL_ROWS + 1); // + header
    fireEvent.click(screen.getByRole("button", { name: "Show all 28" }));
    expect(screen.getAllByRole("row")).toHaveLength(28 + 1);
  });

  it("offers no expander when everything already fits", () => {
    render(<PromptMatrix rows={[row(0)]} />);

    expect(screen.queryByRole("button", { name: /show all/i })).not.toBeInTheDocument();
  });

  it("links a cell to that prompt's detail page with the engine tab pre-opened", () => {
    render(<PromptMatrix rows={[row(0)]} />);

    expect(
      screen.getByRole("link", {
        name: "best localization tools 0 — GPT-5.x API + web search: named in 2 of 3 answers",
      })
    ).toHaveAttribute("href", "/ai-visibility/prompts/p0?engine=openai");
  });

  it("names a dashed cell by WHY it is dashed — the visible text is a bare dash", () => {
    const failed = { named: null, samples: 0, failed: true };
    const thin = { named: 1, samples: 2, failed: false };
    render(
      <PromptMatrix
        rows={[
          row(0, {
            cells: { openai: failed, gemini: thin, anthropic: thin } as MatrixRow["cells"],
          }),
        ]}
      />
    );

    // Engine scope, not prompt scope: `failed` comes from per-engine health.
    expect(
      screen.getByRole("link", {
        name: "best localization tools 0 — GPT-5.x API + web search: no usable answers; this engine failed during the last run",
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "best localization tools 0 — Gemini API, grounded: fewer than 3 usable answers yet",
      })
    ).toBeInTheDocument();
  });

  it("spells the count out for a screen reader — 'named in 2 of 3', never a tick", () => {
    render(<PromptMatrix rows={[row(0, { cells: cells(2) })]} />);

    const cell = screen.getAllByRole("link", { name: /named in 2 of 3 answers/ })[0];
    // The visible glyph is the compact form; the accessible name is the sentence.
    expect(cell.textContent).toBe("2/3");
    expect(cell.getAttribute("aria-label")).not.toMatch(/yes|no|true|false|✓|✗/i);
  });

  it("fills a 3-of-3 cell with the accent and leaves a 0-of-3 an outline, not an error tone", () => {
    // Named on every sample is state, which is what the accent is for. Being
    // unnamed on one prompt is a gap to work on, not a failure.
    const { container, rerender } = render(<PromptMatrix rows={[row(0, { cells: cells(3) })]} />);
    expect(container.querySelector("tbody a[href*='engine=']")!.className).toContain("bg-brand-subtle");

    rerender(<PromptMatrix rows={[row(0, { cells: cells(0) })]} />);
    const absent = container.querySelector("tbody a[href*='engine=']")!.className;
    expect(absent).toContain("border-border");
    expect(absent).not.toContain("bg-brand-subtle");
    expect(absent).not.toContain("destructive");

    rerender(<PromptMatrix rows={[row(0, { cells: cells(1, 2) })]} />);
    const unavailable = container.querySelector("tbody a[href*='engine=']")!.className;
    expect(unavailable).toContain("border-dashed");
  });

  it("marks a brand-check row, so its 3/3 is not read as a discovery win", () => {
    render(<PromptMatrix rows={[row(0, { branded: true })]} />);

    expect(screen.getByText("Brand check")).toBeInTheDocument();
  });

  it("links the prompt text to the detail page with no engine preselected", () => {
    render(<PromptMatrix rows={[row(0)]} />);

    expect(screen.getByRole("link", { name: "best localization tools 0" })).toHaveAttribute(
      "href",
      "/ai-visibility/prompts/p0"
    );
  });
});
