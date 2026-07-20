// tests/lib/publishing/markdown-to-html.test.ts
import { describe, it, expect } from "vitest";
import { markdownToWebflowHtml, containsCodeBlock } from "../../../src/lib/publishing/markdown-to-html";

describe("markdownToWebflowHtml", () => {
  it("converts headings and paragraphs", () => {
    const html = markdownToWebflowHtml("# Title\n\nSome text.");
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<p>Some text.</p>");
  });

  it("converts emphasis, lists and links", () => {
    const html = markdownToWebflowHtml("- **bold** and *italic*\n- [link](https://x.com)");
    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain('<a href="https://x.com">link</a>');
  });

  it("downgrades fenced code to paragraph text instead of emitting <pre>", () => {
    // Webflow's Rich Text field turns <pre>/<code> into an empty string, so the
    // content would silently vanish.
    const html = markdownToWebflowHtml("```js\nconst a = 1;\nconst b = 2;\n```");
    expect(html).not.toContain("<pre");
    expect(html).not.toContain("<code");
    expect(html).toContain("const a = 1;");
    expect(html).toContain("const b = 2;");
    expect(html).toContain("<br>");
  });

  it("downgrades inline code to plain text", () => {
    const html = markdownToWebflowHtml("Use `npm test` now.");
    expect(html).not.toContain("<code");
    expect(html).toContain("npm test");
  });

  it("escapes HTML entities in code content", () => {
    const html = markdownToWebflowHtml("```\n<script>alert(1)</script>\n```");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("strips raw HTML that Webflow would drop anyway", () => {
    const html = markdownToWebflowHtml('<div class="x">hi</div>\n\nAfter.');
    expect(html).not.toContain("<div");
    expect(html).toContain("After.");
  });

  it("preserves images as external URLs", () => {
    const html = markdownToWebflowHtml("![alt text](https://cdn.example.com/a.png)");
    expect(html).toContain('src="https://cdn.example.com/a.png"');
    expect(html).toContain('alt="alt text"');
  });

  it("returns an empty string for empty input", () => {
    expect(markdownToWebflowHtml("")).toBe("");
    expect(markdownToWebflowHtml("   \n  ")).toBe("");
  });
});

describe("containsCodeBlock", () => {
  it("detects fenced code", () => {
    expect(containsCodeBlock("text\n\n```js\nx\n```")).toBe(true);
  });

  it("detects indented code blocks", () => {
    expect(containsCodeBlock("text\n\n    indented code\n")).toBe(true);
  });

  it("is false for prose with inline code", () => {
    expect(containsCodeBlock("just `inline` prose")).toBe(false);
  });
});
