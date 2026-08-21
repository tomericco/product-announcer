import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import {
  PromptsEditor,
  engineChipLine,
  type PromptRowData,
} from "../../../src/app/(dashboard)/ai-visibility/prompts/prompts-editor";
import {
  SuggestionsSection,
  approveLabel,
  type ProposalRow,
} from "../../../src/app/(dashboard)/ai-visibility/prompts/suggestions-section";
import { PROMPTS_FILTER_DEFAULTS } from "../../../src/app/(dashboard)/ai-visibility/prompts/filter-params";

const { push, refresh, approveProposalsAction, togglePromptAction, savePromptAction, deletePromptAction } =
  vi.hoisted(() => ({
    push: vi.fn(),
    refresh: vi.fn(),
    approveProposalsAction: vi.fn<(form: FormData) => Promise<{ ok: boolean; approved?: number }>>(async () => ({
      ok: true,
      approved: 2,
      rejected: 1,
    })),
    togglePromptAction: vi.fn<(promptId: string, active: boolean) => Promise<{ ok: boolean }>>(async () => ({
      ok: true,
    })),
    savePromptAction: vi.fn<(form: FormData) => Promise<{ ok: boolean; superseded?: boolean }>>(async () => ({
      ok: true,
      promptId: "p9",
      superseded: true,
    })),
    deletePromptAction: vi.fn<(promptId: string) => Promise<{ ok: boolean }>>(async () => ({ ok: true })),
  }));

// One router object for every render — it sits in effect dependency lists.
const { router } = vi.hoisted(() => ({ router: {} as Record<string, unknown> }));
router.push = push;
router.refresh = refresh;
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("../../../src/app/(dashboard)/ai-visibility/actions", () => ({
  approveProposalsAction,
  togglePromptAction,
  savePromptAction,
  deletePromptAction,
  generatePromptSetAction: vi.fn(async () => ({ ok: true as const, proposed: 3 })),
}));

beforeEach(() => vi.clearAllMocks());

function row(overrides: Partial<PromptRowData> = {}): PromptRowData {
  return {
    id: "p1",
    text: "best localization tools for design teams",
    intent: "discovery",
    persona: "Head of Design",
    competitorName: null,
    origin: "generated",
    status: "active",
    branded: false,
    flagReason: null,
    deletable: false,
    chips: [
      { engine: "openai", named: 2, samples: 3 },
      { engine: "perplexity", named: 0, samples: 3 },
      { engine: "gemini", named: 3, samples: 3 },
      { engine: "anthropic", named: 1, samples: 3 },
    ],
    ...overrides,
  };
}

function proposal(overrides: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: "s1",
    text: "best localization tools",
    intent: "discovery",
    persona: null,
    competitorName: null,
    flagReason: null,
    ...overrides,
  };
}

function editor(overrides: Partial<Parameters<typeof PromptsEditor>[0]> = {}) {
  return render(
    <PromptsEditor
      rows={[row()]}
      filters={PROMPTS_FILTER_DEFAULTS}
      personas={["Head of Design"]}
      competitors={[]}
      activeCount={28}
      maxActive={30}
      {...overrides}
    />
  );
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

describe("engineChipLine", () => {
  it("reads as counts per engine, in a fixed order", () => {
    expect(engineChipLine(row().chips)).toBe("GPT 2/3 · Pplx 0/3 · Gem 3/3 · Claude 1/3");
  });

  it("dashes an engine with no usable samples rather than printing 0/0", () => {
    expect(engineChipLine([{ engine: "openai", named: null, samples: 0 }])).toBe("GPT –");
  });
});

describe("PromptsEditor", () => {
  it("shows the cap as a count badge", () => {
    editor();
    expect(screen.getByText("28 / 30")).toBeInTheDocument();
  });

  it("disables Add at the cap, with the reason readable", () => {
    editor({ activeCount: 30 });
    expect(screen.getByRole("button", { name: "Add prompt" })).toBeDisabled();
    expect(screen.getByText("30 / 30 limit")).toBeInTheDocument();
  });

  it("gives a paused row the stale treatment, not a hidden one", () => {
    const { container } = editor({ rows: [row({ status: "paused" })] });
    const rowEl = container.querySelector("[data-prompt-row]");
    expect(rowEl?.className).toContain("opacity-85");
    expect(rowEl?.className).toContain("dashed-outline");
    expect(screen.getByText("best localization tools for design teams")).toBeInTheDocument();
  });

  it("flips a prompt through the action and refreshes", async () => {
    editor();
    await click(screen.getByRole("switch", { name: /best localization tools/i }));
    expect(togglePromptAction).toHaveBeenCalledWith("p1", false);
    expect(refresh).toHaveBeenCalled();
  });

  it("offers Delete only when the prompt has never run, and says why when it has not", async () => {
    editor({ rows: [row({ deletable: false })] });
    await click(screen.getByRole("button", { name: /more actions/i }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Delete").closest("[role='menuitem']")).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(within(menu).getByText(/pause it instead/i)).toBeInTheDocument();
  });

  it("warns, before committing, that editing creates a new prompt", async () => {
    editor();
    await click(screen.getByRole("button", { name: /more actions/i }));
    await click(within(screen.getByRole("menu")).getByText("Edit"));

    expect(
      screen.getByText("Saving creates a new prompt and pauses this one — its history stays on the old wording.")
    ).toBeInTheDocument();

    const input = screen.getByRole("textbox", { name: "Prompt text" });
    fireEvent.change(input, { target: { value: "best localisation tools for design teams" } });
    await click(screen.getByRole("button", { name: "Save as a new prompt" }));

    expect(savePromptAction).toHaveBeenCalled();
    const form = savePromptAction.mock.calls[0][0] as FormData;
    expect(form.get("promptId")).toBe("p1");
    expect(form.get("text")).toBe("best localisation tools for design teams");
  });

  it("pushes a filter change onto the url rather than filtering in place", async () => {
    editor();
    // A Base UI Select is not a native <select>: it opens on click and the
    // option commits on Enter, exactly as `new-brief-editor.test.tsx` drives
    // the same primitive.
    await click(screen.getByRole("combobox", { name: "Status" }));
    const option = screen.getByRole("option", { name: "Paused" });
    await act(async () => {
      option.focus();
      fireEvent.keyDown(option, { key: "Enter" });
      fireEvent.keyUp(option, { key: "Enter" });
    });
    expect(push).toHaveBeenCalledWith("/ai-visibility/prompts?status=paused");
  });

  it("badges a flagged prompt with the reason and suggests pausing, without pausing it", () => {
    editor({ rows: [row({ flagReason: "No brands named in three runs" })] });
    expect(screen.getByText("No brands named in three runs")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /best localization tools/i })).toBeChecked();
  });
});

describe("approveLabel", () => {
  it("counts what is checked against what was offered", () => {
    expect(approveLabel(28, 30)).toBe("Approve 28 of 30");
    expect(approveLabel(0, 30)).toBe("Approve none");
  });
});

describe("SuggestionsSection", () => {
  // A batch of ≤10 proposals mounts COLLAPSED — the monthly top-up strip —
  // so every review-flow test must expand it first, exactly as a human
  // does. Only a big batch (the initial ~30) mounts expanded.
  it("mounts a small batch as the collapsed strip, then checks every row on Review — review is exclusion, not selection", async () => {
    render(
      <SuggestionsSection
        proposals={[proposal({ id: "s1" }), proposal({ id: "s2" })]}
        profileChangedNote={null}
        canSuggestMore
        suggestMoreReason={null}
      />
    );

    // Collapsed: the strip and its Review button, no checkboxes in the DOM.
    expect(screen.getByText(/2 new suggestions/)).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);

    await click(screen.getByRole("button", { name: "Review" }));

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).toBeChecked();
    expect(screen.getByRole("button", { name: "Approve 2 of 2" })).toBeInTheDocument();
  });

  it("mounts a big batch already expanded — the initial ~30 must not hide behind a click", () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      proposal({ id: `s${index}`, text: `suggested prompt number ${index}` })
    );
    render(
      <SuggestionsSection proposals={many} profileChangedNote={null} canSuggestMore suggestMoreReason={null} />
    );

    expect(screen.getAllByRole("checkbox")).toHaveLength(12);
    expect(screen.queryByRole("button", { name: "Review" })).not.toBeInTheDocument();
  });

  it("sends the unchecked rows as rejections and the edited text as an edit", async () => {
    render(
      <SuggestionsSection
        proposals={[proposal({ id: "s1" }), proposal({ id: "s2", text: "localization tools pricing" })]}
        profileChangedNote={null}
        canSuggestMore
        suggestMoreReason={null}
      />
    );

    await click(screen.getByRole("button", { name: "Review" }));

    await click(screen.getAllByRole("checkbox")[0]);
    fireEvent.change(screen.getByDisplayValue("localization tools pricing"), {
      target: { value: "how much do localization tools cost" },
    });
    await click(screen.getByRole("button", { name: "Approve 1 of 2" }));

    const form = approveProposalsAction.mock.calls[0][0] as FormData;
    expect(form.getAll("approve")).toEqual(["s2"]);
    expect(form.getAll("reject")).toEqual(["s1"]);
    expect(form.get("text:s2")).toBe("how much do localization tools cost");
  });

  it("shows the profile-changed strip when the profile outgrew the prompts", () => {
    render(
      <SuggestionsSection
        proposals={[]}
        profileChangedNote="Profile changed since prompts were generated — 2 competitors added"
        canSuggestMore
        suggestMoreReason={null}
      />
    );

    expect(screen.getByText(/Profile changed since prompts were generated/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Suggest more" })).toBeEnabled();
  });

  it("disables Suggest more at the cap with a stated reason", () => {
    render(
      <SuggestionsSection
        proposals={[]}
        profileChangedNote={null}
        canSuggestMore={false}
        suggestMoreReason="30 / 30 limit"
      />
    );

    expect(screen.getByRole("button", { name: "Suggest more" })).toBeDisabled();
    expect(screen.getByText("30 / 30 limit")).toBeInTheDocument();
  });
});
