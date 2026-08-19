import { describe, it, expect, afterEach } from "vitest";
import { nearestHeadingAbove } from "../../src/lib/images/nearest-heading";

/**
 * jsdom, not node: this needs a real Selection. No Base UI component is
 * rendered, so none of the observers jsdom lacks (ResizeObserver,
 * matchMedia — neither is stubbed in vitest.setup.jsdom.ts) are involved.
 */
function editor(html: string) {
  const root = document.createElement("div");
  root.className = "mdx-content";
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function caretIn(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("nearestHeadingAbove", () => {
  it("returns the nearest preceding heading of any level", () => {
    const root = editor("<h1>Title</h1><p>Intro</p><h2>Search</h2><p id='t'>Body</p>");
    caretIn(root.querySelector("#t")!);
    expect(nearestHeadingAbove()).toBe("Search");
  });

  it("walks up to the block child of .mdx-content before looking back", () => {
    // The caret is usually in a text node inside a nested inline element.
    const root = editor("<h2>Billing</h2><p id='t'>text <em id='e'>emphasis</em></p>");
    caretIn(root.querySelector("#e")!.firstChild!);
    expect(nearestHeadingAbove()).toBe("Billing");
  });

  it("skips a heading that comes AFTER the caret", () => {
    const root = editor("<h2>Search</h2><p id='t'>Body</p><h2>Billing</h2><p>Later</p>");
    caretIn(root.querySelector("#t")!);
    expect(nearestHeadingAbove()).toBe("Search");
  });

  it("returns null above the first heading", () => {
    const root = editor("<p id='t'>Intro</p><h2>Search</h2>");
    caretIn(root.querySelector("#t")!);
    expect(nearestHeadingAbove()).toBeNull();
  });

  it("returns null when the caret is outside the editor, and when there is no selection", () => {
    const outside = document.createElement("p");
    outside.textContent = "elsewhere";
    document.body.append(outside);
    caretIn(outside);
    expect(nearestHeadingAbove()).toBeNull();

    window.getSelection()!.removeAllRanges();
    expect(nearestHeadingAbove()).toBeNull();
  });

  it("trims the heading text and treats a whitespace-only heading as none", () => {
    const root = editor("<h2>  Faster  search  </h2><p id='t'>Body</p>");
    caretIn(root.querySelector("#t")!);
    expect(nearestHeadingAbove()).toBe("Faster  search");

    const blank = editor("<h2>   </h2><p id='b'>Body</p>");
    caretIn(blank.querySelector("#b")!);
    expect(nearestHeadingAbove()).toBeNull();
  });
});
