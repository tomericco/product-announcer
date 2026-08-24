import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { EngineId } from "../../../src/lib/ai-visibility/types";
import { ENGINE_ORDER } from "../../../src/app/(dashboard)/ai-visibility/engine-labels";
import {
  MATRIX_INITIAL_ROWS,
  PromptMatrix,
  cellReading,
  competitorPhrase,
  rowGapScore,
  sortRows,
  type MatrixCell,
  type MatrixRow,
} from "../../../src/app/(dashboard)/ai-visibility/prompt-matrix";

function cells(named: number | null, samples = 3, competitors = 0): MatrixRow["cells"] {
  const entry: MatrixCell = { named, samples, failed: false, competitors };
  return { openai: entry, gemini: entry, anthropic: entry } as Record<EngineId, MatrixCell>;
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
    expect(cellReading({ named: 2, samples: 3, failed: false, competitors: 0 })).toEqual({ text: "2/3", tone: "partial" });
    expect(cellReading({ named: 3, samples: 3, failed: false, competitors: 0 })).toEqual({ text: "3/3", tone: "full" });
    expect(cellReading({ named: 0, samples: 3, failed: false, competitors: 0 })).toEqual({ text: "0/3", tone: "absent" });
  });

  it("shows a dash for a cell whose engine failed and left nothing, so the gap is not read as a zero", () => {
    expect(cellReading({ named: null, samples: 0, failed: true, competitors: 0 })).toEqual({
      text: "–",
      tone: "unavailable",
    });
  });

  it("shows a dash below the per-prompt threshold of three samples", () => {
    expect(cellReading({ named: 1, samples: 2, failed: false, competitors: 0 }).tone).toBe("unavailable");
  });

  it("dashes an engine that was never asked, rather than reporting 0 of 0", () => {
    // `named: null` is "no cut exists", which the page produces for an engine
    // this prompt has no aggregate row for at all.
    expect(cellReading({ named: null, samples: 0, failed: false, competitors: 0 })).toEqual({
      text: "–",
      tone: "unavailable",
    });
  });

  it("keeps a countable cut when the last run errored on it — three earlier answers are still three answers", () => {
    // The window is four runs deep. Dashing this threw away readings the run
    // that failed never touched, which is how one rate-limited prompt used to
    // blank thirty cells.
    expect(cellReading({ named: 3, samples: 3, failed: true, competitors: 0 })).toEqual({ text: "3/3", tone: "full" });
  });

  it("separates a gap from an empty space — two 0/3s that used to render identically", () => {
    // Rivals named and us absent is a page to write. Nobody named at all is an
    // engine that answers this question without brands, where a comparison
    // page changes nothing. Same "0/3", opposite findings.
    expect(cellReading({ named: 0, samples: 3, failed: false, competitors: 2 })).toEqual({
      text: "0/3",
      tone: "gap",
    });
    expect(cellReading({ named: 0, samples: 3, failed: false, competitors: 0 })).toEqual({
      text: "0/3",
      tone: "absent",
    });
  });

  it("does not call a cell a gap while we are named in it, however many rivals are too", () => {
    expect(cellReading({ named: 1, samples: 3, failed: false, competitors: 4 }).tone).toBe("partial");
    expect(cellReading({ named: 3, samples: 3, failed: false, competitors: 4 }).tone).toBe("full");
  });

  it("still withholds a thin cell, competitors or not — MIN_N_PROMPT is not negotiable", () => {
    expect(cellReading({ named: 0, samples: 2, failed: false, competitors: 3 }).tone).toBe("unavailable");
  });
});

describe("competitorPhrase", () => {
  it("counts competitors in words, singular and plural", () => {
    expect(competitorPhrase(1)).toBe("1 competitor named");
    expect(competitorPhrase(3)).toBe("3 competitors named");
  });

  it("says nothing at all when none were named, so the caller can choose its own wording", () => {
    expect(competitorPhrase(0)).toBe("");
    expect(competitorPhrase(-1)).toBe("");
  });
});

describe("sortRows", () => {
  const ENGINES: EngineId[] = ["openai", "gemini", "anthropic"];

  it("lifts the gap rows to the top — a gap at row 24 is a gap nobody sees", () => {
    // Only the first 20 rows render before "Show all", and creation order is a
    // single batched INSERT whose order means nothing to a reader.
    const rows = [
      row(0, { cells: cells(3) }),
      row(1, { cells: cells(2) }),
      row(2, { cells: cells(0, 3, 2) }),
    ];

    expect(sortRows(rows, ENGINES, "gaps").map((r) => r.promptId)).toEqual(["p2", "p0", "p1"]);
  });

  it("ranks by how many engines show the gap, then by how many rivals", () => {
    const oneEngine = row(0, {
      cells: {
        openai: { named: 0, samples: 3, failed: false, competitors: 5 },
        gemini: { named: 2, samples: 3, failed: false, competitors: 1 },
        anthropic: { named: 2, samples: 3, failed: false, competitors: 1 },
      },
    });
    const everyEngine = row(1, { cells: cells(0, 3, 1) });

    expect(sortRows([oneEngine, everyEngine], ENGINES, "gaps").map((r) => r.promptId)).toEqual(["p1", "p0"]);
  });

  it("does not let a withheld cell reorder the table", () => {
    // Two samples is below MIN_N_PROMPT, so the reader sees a dash. A rank
    // computed from data nobody is shown is a table that reorders for no
    // visible reason.
    const thin = row(0, { cells: cells(0, 2, 4) });
    const named = row(1, { cells: cells(3) });

    expect(sortRows([thin, named], ENGINES, "gaps").map((r) => r.promptId)).toEqual(["p0", "p1"]);
  });

  it("is stable, so equal rows keep the order they came in", () => {
    const rows = [row(0), row(1), row(2)];
    expect(sortRows(rows, ENGINES, "gaps").map((r) => r.promptId)).toEqual(["p0", "p1", "p2"]);
  });

  it("returns creation order untouched when asked for it", () => {
    const rows = [row(0, { cells: cells(3) }), row(1, { cells: cells(0, 3, 2) })];
    expect(sortRows(rows, ENGINES, "prompt")).toBe(rows);
  });
});

describe("rowGapScore", () => {
  const ENGINES: EngineId[] = ["openai", "gemini", "anthropic"];

  it("counts the gap cells and the widest rival count on the row", () => {
    const scored = rowGapScore(
      row(0, {
        cells: {
          openai: { named: 0, samples: 3, failed: false, competitors: 3 },
          gemini: { named: 0, samples: 3, failed: false, competitors: 1 },
          anthropic: { named: 2, samples: 3, failed: false, competitors: 2 },
        },
      }),
      ENGINES
    );

    expect(scored).toEqual({ gaps: 2, competitors: 3 });
  });

  it("counts only the engines it was given, so a disabled engine cannot rank a row", () => {
    const scored = rowGapScore(
      row(0, {
        cells: {
          openai: { named: 2, samples: 3, failed: false, competitors: 0 },
          gemini: { named: 0, samples: 3, failed: false, competitors: 4 },
        },
      }),
      ["openai"]
    );

    expect(scored).toEqual({ gaps: 0, competitors: 0 });
  });
});

describe("PromptMatrix", () => {
  it("shows 20 rows and offers the rest in place", () => {
    const rows = Array.from({ length: 28 }, (_, index) => row(index));
    render(<PromptMatrix rows={rows} engines={ENGINE_ORDER} />);

    expect(screen.getAllByRole("row")).toHaveLength(MATRIX_INITIAL_ROWS + 1); // + header
    fireEvent.click(screen.getByRole("button", { name: "Show all 28" }));
    expect(screen.getAllByRole("row")).toHaveLength(28 + 1);
  });

  it("offers no expander when everything already fits", () => {
    render(<PromptMatrix rows={[row(0)]} engines={ENGINE_ORDER} />);

    expect(screen.queryByRole("button", { name: /show all/i })).not.toBeInTheDocument();
  });

  it("links a cell to that prompt's detail page with the engine tab pre-opened", () => {
    render(<PromptMatrix rows={[row(0)]} engines={ENGINE_ORDER} />);

    expect(
      screen.getByRole("link", {
        name: "best localization tools 0 — ChatGPT API + web search: named in 2 of 3 answers; no competitor named",
      })
    ).toHaveAttribute("href", "/ai-visibility/prompts/p0?engine=openai");
  });

  it("names a dashed cell by WHY it is dashed — the visible text is a bare dash", () => {
    const failed: MatrixCell = { named: null, samples: 0, failed: true, competitors: 0 };
    const thin: MatrixCell = { named: 1, samples: 2, failed: false, competitors: 0 };
    render(
      <PromptMatrix
        engines={ENGINE_ORDER}
        rows={[
          row(0, {
            cells: { openai: failed, gemini: thin, anthropic: thin } as MatrixRow["cells"],
          }),
        ]}
      />
    );

    // Cell scope: `failed` comes from the errored prompt ids on this engine's
    // health row, so it can name this prompt rather than the whole column.
    expect(
      screen.getByRole("link", {
        name: "best localization tools 0 — ChatGPT API + web search: no usable answers; the last run errored on this prompt",
      })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: "best localization tools 0 — Gemini API, grounded: fewer than 3 usable answers yet",
      })
    ).toBeInTheDocument();
  });

  it("spells the count out for a screen reader — 'named in 2 of 3', never a tick", () => {
    render(<PromptMatrix rows={[row(0, { cells: cells(2) })]} engines={ENGINE_ORDER} />);

    const cell = screen.getAllByRole("link", { name: /named in 2 of 3 answers/ })[0];
    // The visible glyph is the compact form; the accessible name is the sentence.
    expect(cell.textContent).toBe("2/3");
    // "no" is excluded from this list on purpose: the name now ends "; no
    // competitor named", which is a count of rivals in words, not a boolean
    // standing in for the sample count.
    expect(cell.getAttribute("aria-label")).not.toMatch(/\byes\b|\btrue\b|\bfalse\b|✓|✗/i);
  });

  it("fills a 3-of-3 cell with the accent and leaves a 0-of-3 an outline, not an error tone", () => {
    // Named on every sample is state, which is what the accent is for. Being
    // unnamed on one prompt is a gap to work on, not a failure.
    const { container, rerender } = render(<PromptMatrix rows={[row(0, { cells: cells(3) })]} engines={ENGINE_ORDER} />);
    expect(container.querySelector("tbody a[href*='engine=']")!.className).toContain("bg-brand-subtle");

    rerender(<PromptMatrix rows={[row(0, { cells: cells(0) })]} engines={ENGINE_ORDER} />);
    const absent = container.querySelector("tbody a[href*='engine=']")!.className;
    expect(absent).toContain("border-border");
    expect(absent).not.toContain("bg-brand-subtle");
    expect(absent).not.toContain("destructive");

    rerender(<PromptMatrix rows={[row(0, { cells: cells(1, 2) })]} engines={ENGINE_ORDER} />);
    const unavailable = container.querySelector("tbody a[href*='engine=']")!.className;
    expect(unavailable).toContain("border-dashed");
  });

  it("shows the rival count in the cell and gives the gap its own outline", () => {
    const { container, rerender } = render(
      <PromptMatrix rows={[row(0, { cells: cells(0, 3, 2) })]} engines={ENGINE_ORDER} />
    );
    const gap = container.querySelector("tbody a[href*='engine=']")!;
    expect(gap.textContent).toBe("0/3·2");
    // --brand-ink, never --brand: the brand guide is explicit that any
    // accent-coloured glyph, label or border uses the ink.
    expect(gap.className).toContain("border-brand-ink");
    expect(gap.className).not.toContain("destructive");

    // The same 0/3 with nobody named keeps the quiet outline it always had.
    rerender(<PromptMatrix rows={[row(0, { cells: cells(0) })]} engines={ENGINE_ORDER} />);
    const empty = container.querySelector("tbody a[href*='engine=']")!;
    expect(empty.textContent).toBe("0/3");
    expect(empty.className).toContain("border-border");
    expect(empty.className).not.toContain("border-brand-ink");
  });

  it("puts the rival count in the accessible name too, since colour reaches nobody using a screen reader", () => {
    render(<PromptMatrix rows={[row(0, { cells: cells(0, 3, 2) })]} engines={ENGINE_ORDER} />);

    expect(
      screen.getByRole("link", {
        name: "best localization tools 0 — ChatGPT API + web search: named in 0 of 3 answers; 2 competitors named",
      })
    ).toBeInTheDocument();
  });

  it("says so in words when nobody was named, rather than leaving the reader to infer it", () => {
    render(<PromptMatrix rows={[row(0, { cells: cells(0) })]} engines={ENGINE_ORDER} />);

    expect(
      screen.getByRole("link", {
        name: "best localization tools 0 — ChatGPT API + web search: named in 0 of 3 answers; no competitor named",
      })
    ).toBeInTheDocument();
  });

  it("sorts gaps first by default, and hands creation order back on request", () => {
    const rows = [row(0, { cells: cells(3) }), row(1, { cells: cells(0, 3, 2) })];
    render(<PromptMatrix rows={rows} engines={ENGINE_ORDER} />);

    const texts = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((tableRow) => tableRow.textContent!.slice(0, 26));
    expect(texts()[0]).toContain("best localization tools 1");

    fireEvent.click(screen.getByRole("button", { name: "Prompt order" }));
    expect(texts()[0]).toContain("best localization tools 0");
  });

  it("marks which sort is active, so the order on screen is never unexplained", () => {
    render(<PromptMatrix rows={[row(0)]} engines={ENGINE_ORDER} />);

    expect(screen.getByRole("button", { name: "Gaps first" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Prompt order" })).toHaveAttribute("aria-pressed", "false");
  });

  it("marks a brand-check row, so its 3/3 is not read as a discovery win", () => {
    render(<PromptMatrix rows={[row(0, { branded: true })]} engines={ENGINE_ORDER} />);

    expect(screen.getByText("Brand check")).toBeInTheDocument();
  });

  it("draws a column only for the engines it was given, not a dead one for a disabled engine", () => {
    render(<PromptMatrix rows={[row(0)]} engines={["openai", "anthropic"]} />);

    expect(screen.getAllByRole("columnheader").map((head) => head.textContent)).toEqual([
      "Prompt",
      "ChatGPT",
      "Claude",
    ]);
    expect(screen.queryByRole("link", { name: /Gemini/ })).not.toBeInTheDocument();
  });

  it("links the prompt text to the detail page with no engine preselected", () => {
    render(<PromptMatrix rows={[row(0)]} engines={ENGINE_ORDER} />);

    expect(screen.getByRole("link", { name: "best localization tools 0" })).toHaveAttribute(
      "href",
      "/ai-visibility/prompts/p0"
    );
  });
});
