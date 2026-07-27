import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../../../src/lib/markdown/render";

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
