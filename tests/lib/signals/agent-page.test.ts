import { describe, it, expect } from "vitest";
import { probeAgentPage, extractBlocks } from "../../../src/lib/signals/agent-page";
import type { PageResult } from "../../../src/lib/workspace/fetch-page";

const LONG = "x".repeat(300);
const ok = (text: string): PageResult => ({
  text,
  html: text,
  finalUrl: "https://rival.com/x",
  contentType: "text/markdown",
});

function fakeFetcher(pages: Record<string, PageResult>) {
  const calls: string[] = [];
  return {
    calls,
    fetchPage: async (url: string): Promise<PageResult> => {
      calls.push(url);
      return pages[url] ?? { error: "fetch-failed" };
    },
  };
}

describe("probeAgentPage", () => {
  it("prefers the page's own .md variant", async () => {
    const { fetchPage, calls } = fakeFetcher({
      "https://rival.com/changelog.md": ok(`# Changelog ${LONG}`),
    });
    expect(await probeAgentPage("https://rival.com/changelog", { fetchPage })).toBe(
      "https://rival.com/changelog.md"
    );
    expect(calls[0]).toBe("https://rival.com/changelog.md");
  });

  it("falls back to the site's llms.txt when no .md variant exists", async () => {
    const { fetchPage } = fakeFetcher({
      "https://rival.com/llms.txt": ok(`# Rival ${LONG}`),
    });
    expect(await probeAgentPage("https://rival.com/changelog", { fetchPage })).toBe(
      "https://rival.com/llms.txt"
    );
  });

  it("returns null when nothing agent-facing is published", async () => {
    const { fetchPage } = fakeFetcher({});
    expect(await probeAgentPage("https://rival.com/changelog", { fetchPage })).toBeNull();
  });

  it("does not probe a .md variant for a url that already ends in .md or .txt", async () => {
    const { fetchPage, calls } = fakeFetcher({});
    await probeAgentPage("https://rival.com/llms.txt", { fetchPage });
    expect(calls).not.toContain("https://rival.com/llms.txt.md");
  });

  it("bounds itself — at most three probes for one page", async () => {
    const { fetchPage, calls } = fakeFetcher({});
    await probeAgentPage("https://rival.com/changelog", { fetchPage });
    expect(calls.length).toBeLessThanOrEqual(3);
  });
});

describe("extractBlocks", () => {
  it("splits on blank lines and titles each block from its first line", () => {
    const blocks = extractBlocks(
      "## v2.4.0\nAdded SAML SSO for every plan, including free.\n\n## v2.3.0\nFixed a crash when loading large workspaces."
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].title).toBe("## v2.4.0");
    expect(blocks[0].text).toContain("SAML SSO");
    expect(blocks[1].title).toBe("## v2.3.0");
  });

  it("starts a new block at a markdown heading even without a blank line", () => {
    const blocks = extractBlocks(
      "## First\nA first section with enough text to clear the floor.\n## Second\nA second section with enough text as well."
    );
    expect(blocks.map((b) => b.title)).toEqual(["## First", "## Second"]);
  });

  it("hashes block content, so identical text in two places collapses to one hash", () => {
    const [a, b] = extractBlocks(
      "An identical changelog entry appears twice here.\n\nAn identical changelog entry appears twice here."
    );
    expect(a.hash).toBe(b.hash);
  });

  it("gives different hashes to different content", () => {
    const [a, b] = extractBlocks(
      "One changelog entry with plenty of text in it.\n\nA different changelog entry entirely, also long."
    );
    expect(a.hash).not.toBe(b.hash);
  });

  it("is insensitive to trailing whitespace changes, so reformatting is not a new block", () => {
    // Two lines on purpose, with the padding on the FIRST one. A single-line
    // fixture cannot fail: the outer trim strips it regardless, so the test
    // would pass even with the per-line normalization deleted — which is the
    // regression this test exists to catch.
    const [padded] = extractBlocks("Line one with padding.   \nLine two of the same block.\n\nnext");
    const [plain] = extractBlocks("Line one with padding.\nLine two of the same block.\n\nnext");
    expect(padded.hash).toBe(plain.hash);
  });

  it("drops blocks too short to carry meaning", () => {
    expect(extractBlocks("ok\n\nA genuinely substantial block of changelog text.")).toHaveLength(1);
  });

  it("drops nav-sized fragments while keeping a real changelog line", () => {
    const blocks = extractBlocks("Pricing\n\nSign in\n\nAdded SAML SSO for every plan.");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain("SAML SSO");
  });

  it("drops a heading with no body, and keeps the one that has content", () => {
    const blocks = extractBlocks("## First\n## Second\nA section with enough body text to count.");
    expect(blocks.map((b) => b.title)).toEqual(["## Second"]);
  });

  it("returns an empty array for empty or whitespace-only input", () => {
    expect(extractBlocks("")).toEqual([]);
    expect(extractBlocks("   \n\n  \n")).toEqual([]);
  });

  it("caps the number of blocks it returns", () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `Block number ${i} with enough text.`).join("\n\n");
    expect(extractBlocks(huge).length).toBeLessThanOrEqual(500);
  });
});
