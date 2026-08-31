import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The component imports server actions, which pull in the database layer and
// cannot load under jsdom. Only the drawer's own behaviour is under test here.
const importBrandStyleFromUrl = vi.fn();
const importProductUpdateTemplateFromUrl = vi.fn();
vi.mock("../../../src/app/(dashboard)/company/actions", () => ({
  importBrandStyleFromUrl: (...args: unknown[]) => importBrandStyleFromUrl(...args),
  importProductUpdateTemplateFromUrl: (...args: unknown[]) => importProductUpdateTemplateFromUrl(...args),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { UpdatesPageImport } from "../../../src/app/(dashboard)/company/updates-page-import";

describe("UpdatesPageImport", () => {
  beforeEach(() => {
    importBrandStyleFromUrl.mockReset();
    importProductUpdateTemplateFromUrl.mockReset();
  });

  it("renders the band's heading and form without needing to be opened", () => {
    // Not a disclosure: the band is always visible, set apart by its tint
    // rather than by being hidden.
    render(<UpdatesPageImport kind="guidelines" defaultUrl="https://acme.com/changelog" />);

    expect(screen.getByText("Generate from your updates page")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("https://acme.com/changelog");
    expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled();
  });

  it("renders as a card-footer slot, which is what tints it and squares it to the card", () => {
    // `Card` keys both its bottom padding and the band's rounded corners off
    // this slot, so losing it silently breaks the layout rather than erroring.
    const { container } = render(<UpdatesPageImport kind="template" defaultUrl="https://acme.com/x" />);
    expect(container.querySelector('[data-slot="card-footer"]')).not.toBeNull();
  });

  it("does not run until the confirm dialog is accepted", async () => {
    const user = userEvent.setup();
    importProductUpdateTemplateFromUrl.mockResolvedValue({ ok: true });
    render(<UpdatesPageImport kind="template" defaultUrl="https://acme.com/changelog" />);

    await user.click(screen.getByRole("button", { name: "Generate" }));

    // Opening the drawer is not consent. Both analyses overwrite hand-tuned
    // work, so the dialog is the actual guard.
    expect(importProductUpdateTemplateFromUrl).not.toHaveBeenCalled();
    expect(screen.getByText("Replace your product update template?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(importProductUpdateTemplateFromUrl).toHaveBeenCalledWith("https://acme.com/changelog");
  });

  it("routes each kind to its own action", async () => {
    const user = userEvent.setup();
    importBrandStyleFromUrl.mockResolvedValue({ ok: true });
    render(<UpdatesPageImport kind="guidelines" defaultUrl="https://acme.com/changelog" />);

    await user.click(screen.getByRole("button", { name: "Generate" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(importBrandStyleFromUrl).toHaveBeenCalledWith("https://acme.com/changelog");
    expect(importProductUpdateTemplateFromUrl).not.toHaveBeenCalled();
  });
});
