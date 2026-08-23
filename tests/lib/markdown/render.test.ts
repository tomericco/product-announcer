import { describe, it, expect } from "vitest";
import { escapeMarkdownText, renderMarkdown } from "../../../src/lib/markdown/render";

describe("renderMarkdown", () => {
  it("renders headings, paragraphs, lists and emphasis", () => {
    const html = renderMarkdown("# Title\n\nHello **world**\n\n- a\n- b");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>world</strong>");
    expect(html).toContain("<li>a</li>");
  });

  it("returns empty string for blank input", () => {
    expect(renderMarkdown("   ")).toBe("");
  });

  it("drops raw HTML (e.g. <script>)", () => {
    const html = renderMarkdown("hi\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });

  it("neutralizes a javascript: link href but keeps the text", () => {
    const html = renderMarkdown("[click me](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click me");
    expect(html).toContain('href=""');
  });

  it("keeps a normal http link and marks it noopener", () => {
    const html = renderMarkdown("[docs](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("neutralizes a javascript: image src but keeps the alt text", () => {
    const html = renderMarkdown("![alt](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("alt");
    expect(html).toContain('src=""');
  });

  it("keeps a normal image src", () => {
    const html = renderMarkdown("![a](https://ex.com/i.png)");
    expect(html).toContain('src="https://ex.com/i.png"');
  });

  it("neutralizes a protocol-relative link href", () => {
    const html = renderMarkdown("[x](//evil.com)");
    expect(html).toContain('href=""');
  });

  it("keeps a normal relative link and an anchor link", () => {
    const relative = renderMarkdown("[a](/path)");
    expect(relative).toContain('href="/path"');

    const anchor = renderMarkdown("[a](#section)");
    expect(anchor).toContain('href="#section"');
  });
});

describe("renderMarkdown with a renderText seam", () => {
  it("hands the callback raw prose and takes its HTML back", () => {
    const html = renderMarkdown("Hello **world**", { renderText: (text) => `<mark>${text}</mark>` });

    expect(html).toBe("<p><mark>Hello </mark><strong><mark>world</mark></strong></p>");
  });

  it("never hands it an href, a code span or a fenced block", () => {
    // The property that makes decorating prose safe: the callback only ever
    // sees text nodes, so nothing it returns can land inside a tag, an
    // attribute or code.
    const seen: string[] = [];
    renderMarkdown("[docs](https://example.com/a) `code here`\n\n```\nfenced\n```", {
      renderText: (text) => {
        seen.push(text);
        return text;
      },
    });

    expect(seen).toContain("docs");
    expect(seen.join(" ")).not.toContain("https://example.com/a");
    expect(seen.join(" ")).not.toContain("code here");
    expect(seen.join(" ")).not.toContain("fenced");
  });

  it("recurses into an inline container rather than printing its source", () => {
    // A loose list item's text token carries child tokens; treating it as a
    // leaf would print the emphasis inside it as markdown.
    const html = renderMarkdown("- loose **item**\n\n- second\n", { renderText: (text) => text });

    expect(html).toContain("<strong>item</strong>");
    expect(html).not.toContain("**");
  });

  it("leaves the default escaping in place for a caller that adds nothing", () => {
    // `escapeMarkdownText` is what the seam replaces, so a pass-through of it
    // must be byte-identical to no seam at all — entities included.
    const source = "5 < 6 & 7 &amp; 8 \"quoted\"";
    expect(renderMarkdown(source, { renderText: escapeMarkdownText })).toBe(renderMarkdown(source));
  });

  it("still drops raw HTML when a seam is supplied", () => {
    const html = renderMarkdown("<script>alert(1)</script> ok", { renderText: (text) => text });

    expect(html).not.toContain("<script");
  });
});
