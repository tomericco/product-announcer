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
  return { openai: entry, perplexity: entry, gemini: entry, anthropic: entry } as Record<
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

    expect(screen.getByRole("link", { name: "GPT 2/3" })).toHaveAttribute(
      "href",
      "/ai-visibility/prompts/p0?engine=openai"
    );
  });
});
