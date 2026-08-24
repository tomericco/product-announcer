import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

/**
 * The dashboard content column's one decision: narrow measure, or full width.
 *
 * Nothing tested this before. `WIDE_ROUTES` is a plain array read by a
 * `startsWith` match, so dropping an entry — or adding one whose prefix
 * accidentally swallows a sibling route — changes the layout of a whole
 * section with no other test in the suite going red.
 */
const usePathname = vi.fn(() => "/signals");
vi.mock("next/navigation", () => ({ usePathname: () => usePathname() }));

import { MainContainer } from "../../src/app/(dashboard)/main-container";

function widthAt(pathname: string): string {
  usePathname.mockReturnValue(pathname);
  const { container } = render(
    <MainContainer>
      <p>content</p>
    </MainContainer>
  );
  return container.firstElementChild!.className;
}

describe("MainContainer", () => {
  it("keeps a reading-shaped page at the narrow measure", () => {
    for (const route of ["/signals", "/drafts", "/company", "/settings", "/history"]) {
      expect(widthAt(route)).toContain("max-w-4xl");
    }
  });

  it("gives the column-shaped pages the full width", () => {
    // AI visibility is five metric cards abreast and a prompt × engine matrix
    // five columns wide: at max-w-4xl the matrix scrolls sideways and hides
    // the per-engine comparison the row exists to make.
    for (const route of ["/board", "/calendar", "/ai-visibility"]) {
      const className = widthAt(route);
      expect(className).toContain("max-w-none");
      expect(className).not.toContain("max-w-4xl");
    }
  });

  it("carries the width down every nested route, not just the index", () => {
    expect(widthAt("/ai-visibility/prompts")).toContain("max-w-none");
    expect(widthAt("/ai-visibility/prompts/abc-123")).toContain("max-w-none");
  });

  it("does not widen a route that merely starts with the same letters", () => {
    // `startsWith` is guarded by a trailing slash for exactly this: a future
    // `/ai-visibility-settings` must not inherit the board's layout.
    expect(widthAt("/ai-visibility-settings")).toContain("max-w-4xl");
    expect(widthAt("/boardroom")).toContain("max-w-4xl");
  });
});
