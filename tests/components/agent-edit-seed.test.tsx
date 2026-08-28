import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * The other half of the failed-review flow: the instruction box has to OPEN
 * carrying the seed, and stop showing it the moment the user types. The
 * value is derived (`instruction ?? seed`) rather than pushed into state by
 * an effect, so both halves of that are worth pinning.
 *
 * `./actions` is a `"use server"` module reaching `@/db`; `next/navigation`'s
 * `useRouter` throws outside a mounted App Router. Both mocked, as elsewhere
 * in this directory.
 */
vi.mock("../../src/app/(dashboard)/drafts/[releaseId]/actions", () => ({
  requestAgentEdit: vi.fn(),
  saveDraftBody: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("../../src/app/(dashboard)/unsaved-changes", () => ({
  useUnsavedChanges: () => ({ notifySaved: vi.fn() }),
}));

import {
  AgentEditProvider,
  useAgentEdit,
} from "../../src/app/(dashboard)/drafts/[releaseId]/agent-edit-context";
import { AgentEditDialog } from "../../src/app/(dashboard)/drafts/[releaseId]/agent-edit-dialog";

function Opener({ seed }: { seed?: string }) {
  const { openWholeEdit } = useAgentEdit();
  return (
    <button type="button" onClick={() => openWholeEdit(seed)}>
      open
    </button>
  );
}

function renderWith(seed?: string) {
  return render(
    <AgentEditProvider>
      <Opener seed={seed} />
      <AgentEditDialog contentPieceId="cp-1" />
    </AgentEditProvider>
  );
}

describe("the whole-update edit dialog's seed", () => {
  it("opens prefilled with the instruction it was given", () => {
    renderWith("Fix these:\n- Too much jargon");
    fireEvent.click(screen.getByRole("button", { name: "open" }));

    const box = screen.getByRole("textbox");
    expect(box).toHaveValue("Fix these:\n- Too much jargon");
    // The seed is a real instruction, so Apply is live immediately — the
    // point of prefilling is that another iteration is one more click.
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("hands the box back to the user the moment they type", () => {
    renderWith("Fix these:\n- Too much jargon");
    fireEvent.click(screen.getByRole("button", { name: "open" }));

    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "Actually, make it shorter" } });
    expect(box).toHaveValue("Actually, make it shorter");

    // Including clearing it: an empty box must disable Apply, not fall back
    // to the seed.
    fireEvent.change(box, { target: { value: "" } });
    expect(box).toHaveValue("");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("opens empty when nothing seeded it", () => {
    renderWith();
    fireEvent.click(screen.getByRole("button", { name: "open" }));

    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });
});
