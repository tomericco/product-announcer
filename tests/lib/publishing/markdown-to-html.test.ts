// tests/lib/publishing/markdown-to-html.test.ts
import { describe, it, expect, vi } from "vitest";
import { Lexer } from "marked";
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

  it("short-circuits on empty/whitespace-only input without invoking the parser", () => {
    // marked itself already returns "" for empty/whitespace input, so asserting
    // on the output alone doesn't prove the `if (!markdown.trim()) return "";`
    // guard exists. Assert on the guard's actual effect instead: the lexer is
    // never invoked. Without the guard, marked's `parse()` would still reach
    // `Lexer.lex` internally (and would itself return ""), making this
    // assertion fail even though the output-only assertions above still pass.
    const lexSpy = vi.spyOn(Lexer, "lex");
    try {
      expect(markdownToWebflowHtml("")).toBe("");
      expect(markdownToWebflowHtml("   \n  ")).toBe("");
      expect(lexSpy).not.toHaveBeenCalled();
    } finally {
      lexSpy.mockRestore();
    }
  });

  it("downgrades strikethrough to <s>, not <del>", () => {
    const html = markdownToWebflowHtml("~~struck~~");
    expect(html).toContain("<s>struck</s>");
    expect(html).not.toContain("<del");
  });

  it("downgrades GFM tables to paragraphs, preserving every cell's text and dropping table tags", () => {
    const html = markdownToWebflowHtml(
      "| Name | Status |\n| --- | --- |\n| Widget | Shipped |\n| Gadget | Planned |",
    );
    expect(html).not.toContain("<table");
    expect(html).not.toContain("<thead");
    expect(html).not.toContain("<tr");
    expect(html).not.toContain("<th");
    expect(html).not.toContain("<td");
    expect(html).toContain("Name");
    expect(html).toContain("Status");
    expect(html).toContain("Widget");
    expect(html).toContain("Shipped");
    expect(html).toContain("Gadget");
    expect(html).toContain("Planned");
  });

  it("escapes HTML-special characters in table cells", () => {
    const html = markdownToWebflowHtml(
      "| Field | Value |\n| --- | --- |\n| tag | <script>alert(1)</script> & co |",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("only ever emits tags from Webflow's allowed set across every supported construct", () => {
    const markdown = [
      "# Heading 1",
      "## Heading 2",
      "",
      "A paragraph with **bold**, *italic*, ~~strikethrough~~, and a [link](https://x.com).",
      "",
      "- bullet one",
      "- bullet two",
      "",
      "1. first",
      "2. second",
      "",
      "> A blockquote.",
      "",
      "![alt text](https://cdn.example.com/a.png)",
      "",
      "```js",
      "const a = 1;",
      "```",
      "",
      "Some `inline code` here.",
      "",
      "| Col A | Col B |",
      "| --- | --- |",
      "| one | two |",
      "",
      '<div class="raw">raw html</div>',
    ].join("\n");

    const html = markdownToWebflowHtml(markdown);

    const allowedTags = new Set([
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "strong",
      "em",
      "u",
      "s",
      "a",
      "ul",
      "ol",
      "li",
      "blockquote",
      "br",
      "img",
    ]);

    const foundTags = new Set(
      Array.from(html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b/g)).map((match) => match[1].toLowerCase()),
    );

    expect(foundTags.size).toBeGreaterThan(0);
    for (const tag of foundTags) {
      expect(allowedTags.has(tag)).toBe(true);
    }
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
