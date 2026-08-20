import { describe, it, expect, vi, beforeEach } from "vitest";
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
 * `usePathname` is mocked as a controllable fn (not a fixed value) because
 * the Company-sections tests below need to render at different routes;
 * everything else in the file just needs a value that isn't `/company`.
 */
const usePathname = vi.fn(() => "/signals");
vi.mock("next/navigation", () => ({ usePathname: () => usePathname() }));

import { NavLinks } from "../../src/app/(dashboard)/nav-links";

beforeEach(() => usePathname.mockReturnValue("/signals"));

// Every route in the sidebar, so "no other entry shows the count" is checked
// against all of them rather than a hand-picked neighbour.
const HREFS = ["/signals", "/board", "/calendar", "/images", "/history", "/integrations", "/company"];

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

describe("NavLinks Company sections — auto expand/collapse, no independent toggle", () => {
  function sectionsRowFor(container: HTMLElement) {
    const companyLink = linkFor(container, "/company");
    // Sibling of the anchor, not a descendant — :scope > excludes the icon
    // svgs inside the anchor, which also carry aria-hidden.
    return companyLink.parentElement!.querySelector(":scope > [aria-hidden]") as HTMLElement;
  }

  it("is collapsed when Company is not the current route", () => {
    usePathname.mockReturnValue("/signals");
    const { container } = render(<NavLinks boardCount={0} />);
    expect(sectionsRowFor(container).className).toContain("grid-rows-[0fr]");
    expect(sectionsRowFor(container).getAttribute("aria-hidden")).toBe("true");
  });

  it("is expanded when the route is exactly /company", () => {
    usePathname.mockReturnValue("/company");
    const { container } = render(<NavLinks boardCount={0} />);
    expect(sectionsRowFor(container).className).toContain("grid-rows-[1fr]");
    expect(sectionsRowFor(container).getAttribute("aria-hidden")).toBe("false");
  });

  it("has no interactive toggle control at all — nothing to click or focus independently of navigation", () => {
    usePathname.mockReturnValue("/company");
    const { container } = render(<NavLinks boardCount={0} />);
    const companyLink = linkFor(container, "/company");
    // No role="button", no tabIndex, no click handler standing in for one —
    // the state is a pure function of the route, so there is nothing for a
    // user to toggle independently of navigating.
    expect(companyLink.querySelector('[role="button"]')).toBeNull();
    const chevron = companyLink.querySelector("svg.lucide-chevron-down") as SVGElement;
    expect(chevron, "chevron indicator should still render").toBeTruthy();
    expect(chevron.getAttribute("aria-hidden")).toBe("true");
  });

  it("every section links into the single /company page by hash, not a separate route", () => {
    usePathname.mockReturnValue("/company");
    const { container } = render(<NavLinks boardCount={0} />);
    const sectionLinks = Array.from(linkFor(container, "/company").parentElement!.querySelectorAll('a[href^="/company#"]'));
    expect(sectionLinks.length).toBe(10);
    for (const link of sectionLinks) {
      expect((link as HTMLAnchorElement).getAttribute("href")).toMatch(/^\/company#/);
    }
  });
});
