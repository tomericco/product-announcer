import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

/**
 * The Board count badge, at its delivery point.
 *
 * `readBoardNavCount` is well covered, so the arithmetic is pinned. What was
 * not covered is that the number reaches the screen at all: the badge is
 * gated on `item.href === "/board"` matching an entry in this file's `NAV`
 * array, and pointing that gate at a route the array no longer contains
 * (`/drafts`, say — the list this badge replaced) renders it nowhere while
 * every other test in the suite stays green. This file is the mutation
 * detector for exactly that: it asserts the count lands on Board, on nothing
 * else, and not at all when there is nothing to count.
 *
 * `usePathname` is mocked because `NavLinks` reads it for the active-item
 * highlight; the value is arbitrary here — none of these assertions are about
 * which item is active.
 */
vi.mock("next/navigation", () => ({ usePathname: () => "/signals" }));

import { NavLinks } from "../../src/app/(dashboard)/nav-links";

// Every route in the sidebar, so "no other entry shows the count" is checked
// against all of them rather than a hand-picked neighbour.
const HREFS = ["/signals", "/board", "/calendar", "/history", "/integrations", "/company"];

function linkFor(container: HTMLElement, href: string) {
  const link = container.querySelector(`a[href="${href}"]`);
  expect(link, `no nav link for ${href}`).not.toBeNull();
  return link as HTMLAnchorElement;
}

describe("NavLinks board count badge", () => {
  it("renders the count on the Board entry", () => {
    const { container } = render(<NavLinks boardCount={7} />);

    expect(linkFor(container, "/board").textContent).toContain("7");
  });

  it("renders it on the Board entry and on no other", () => {
    const { container } = render(<NavLinks boardCount={7} />);

    for (const href of HREFS) {
      const text = linkFor(container, href).textContent ?? "";
      if (href === "/board") expect(text).toContain("7");
      else expect(text, `${href} should not carry the board count`).not.toContain("7");
    }
  });

  it("hides the badge at zero rather than showing a 0", () => {
    const { container } = render(<NavLinks boardCount={0} />);

    // The whole nav, not just Board: a zero must not surface anywhere.
    expect(container.textContent).not.toContain("0");
  });
});
