import { describe, it, expect, vi } from "vitest";
import {
  validateDraftLinks,
  extractHttpLinks,
  hasLinkPlaceholder,
  isValidLinkTarget,
  findMalformedLinks,
  findInvalidLinks,
  collectInvalidLinks,
  applyLinkFixes,
} from "../../../src/lib/ai/validate-links";

describe("hasLinkPlaceholder", () => {
  it("detects the placeholder a dead link is rewritten to", () => {
    expect(hasLinkPlaceholder("See the docs [add link] for more.")).toBe(true);
    expect(hasLinkPlaceholder("Nothing to fill in here.")).toBe(false);
  });
});

describe("isValidLinkTarget", () => {
  it("accepts well-formed http(s) and mailto URLs", () => {
    expect(isValidLinkTarget("https://example.com/x")).toBe(true);
    expect(isValidLinkTarget("http://example.com")).toBe(true);
    expect(isValidLinkTarget("mailto:x@y.com")).toBe(true);
  });

  it("rejects empty, relative, anchor, and malformed targets", () => {
    expect(isValidLinkTarget("")).toBe(false);
    expect(isValidLinkTarget("/pricing")).toBe(false);
    expect(isValidLinkTarget("#section")).toBe(false);
    expect(isValidLinkTarget("htp://typo")).toBe(false);
    expect(isValidLinkTarget("just some text")).toBe(false);
  });
});

describe("findMalformedLinks (synchronous)", () => {
  it("flags a leftover placeholder", () => {
    const problems = findMalformedLinks("See [add link] here.");
    expect(problems).toEqual([{ url: "[add link]", reason: "placeholder" }]);
  });

  it("flags malformed and relative targets, including an empty one, and dedupes", () => {
    const body = "[a](htp://x) [b](/rel) [c]() [dup](htp://x)";
    const problems = findMalformedLinks(body);
    expect(problems).toEqual([
      { url: "htp://x", reason: "malformed" },
      { url: "/rel", reason: "malformed" },
      { url: "(empty)", reason: "malformed" },
    ]);
  });

  it("passes valid links and ignores images", () => {
    expect(findMalformedLinks("[ok](https://example.com) ![img](https://cdn.test/a.png)")).toEqual([]);
  });
});

describe("findInvalidLinks (with reachability)", () => {
  const checkerFor = (live: string[]) => vi.fn(async (url: string) => live.includes(url));

  it("adds an unreachable problem for a well-formed link that doesn't resolve", async () => {
    const problems = await findInvalidLinks("[live](https://ok.test) [dead](https://gone.test)", checkerFor(["https://ok.test"]));
    expect(problems).toEqual([{ url: "https://gone.test", reason: "unreachable" }]);
  });

  it("only probes valid http(s) targets, not malformed ones", async () => {
    const check = checkerFor([]);
    const problems = await findInvalidLinks("[bad](htp://typo) [add link]", check);
    expect(check).not.toHaveBeenCalled();
    expect(problems).toEqual([
      { url: "[add link]", reason: "placeholder" },
      { url: "htp://typo", reason: "malformed" },
    ]);
  });

  it("returns nothing for a body whose links are all valid and reachable", async () => {
    const problems = await findInvalidLinks("[docs](https://ok.test)", checkerFor(["https://ok.test"]));
    expect(problems).toEqual([]);
  });
});

describe("collectInvalidLinks", () => {
  it("locates malformed, unreachable, and placeholder links, skipping valid ones", () => {
    const body = "See [a](htp://x), [ok](https://ok.test), [dead](https://gone.test) and [add link].";
    const links = collectInvalidLinks(body, ["https://gone.test"]);
    expect(links.map((l) => [l.reason, l.text, l.url])).toEqual([
      ["malformed", "a", "htp://x"],
      ["unreachable", "dead", "https://gone.test"],
      ["placeholder", "", ""],
    ]);
    const placeholder = links.find((l) => l.reason === "placeholder")!;
    expect(body.slice(placeholder.start, placeholder.end)).toBe("[add link]");
  });

  it("does not treat [add link](url) as a bare placeholder", () => {
    expect(collectInvalidLinks("[add link](https://ok.test)", [])).toEqual([]);
  });

  // The Markdown editor round-trips a bare `[add link]` by backslash-escaping the
  // brackets. Detection and the replaced span must both cover the escaped form,
  // or a fix leaves a stray `\` that escapes the new link into literal text.
  it("spans the escaping backslashes so a fix leaves none behind", () => {
    const body = "See the changelog \\[add link\\] for details.";
    const links = collectInvalidLinks(body, []);
    expect(links).toHaveLength(1);
    expect(links[0].reason).toBe("placeholder");
    expect(body.slice(links[0].start, links[0].end)).toBe("\\[add link\\]");

    const fixed = applyLinkFixes(body, [{ ...links[0], url: "https://x.test" }]);
    expect(fixed).toBe("See the changelog [https://x.test](https://x.test) for details.");
    expect(fixed).not.toContain("\\");
  });

  it("also handles a half-escaped placeholder (\\[add link])", () => {
    const links = collectInvalidLinks("x \\[add link] y", []);
    expect(links).toHaveLength(1);
    const fixed = applyLinkFixes("x \\[add link] y", [{ ...links[0], url: "https://x.test" }]);
    expect(fixed).toBe("x [https://x.test](https://x.test) y");
  });
});

describe("hasLinkPlaceholder tolerates editor escaping", () => {
  it("detects escaped forms and ignores a real [add link](url) link", () => {
    expect(hasLinkPlaceholder("x \\[add link\\] y")).toBe(true);
    expect(hasLinkPlaceholder("x \\[add link] y")).toBe(true);
    expect(hasLinkPlaceholder("[add link](https://ok.test)")).toBe(false);
    expect(hasLinkPlaceholder("nothing here")).toBe(false);
  });
});

describe("applyLinkFixes", () => {
  it("splices [text](url) for real links and [url](url) for placeholders, right-to-left", () => {
    const body = "See [a](htp://x) and [add link].";
    const fixes = [
      { start: 4, end: 16, text: "a", url: "https://fixed.test/a" },
      { start: 21, end: 31, text: "", url: "https://fixed.test/p" },
    ];
    expect(applyLinkFixes(body, fixes)).toBe(
      "See [a](https://fixed.test/a) and [https://fixed.test/p](https://fixed.test/p)."
    );
  });
});

// A checker driven by a set of "live" URLs; everything else is treated as dead.
const checkerFor = (live: string[]) => vi.fn(async (url: string) => live.includes(url));

describe("extractHttpLinks", () => {
  it("collects unique http(s) URLs and ignores images, anchors, mailto, and relative links", () => {
    const body = [
      "See [docs](https://example.com/docs) and [docs again](https://example.com/docs).",
      "![shot](https://cdn.example.com/a.png)",
      "[jump](#section) [mail](mailto:x@y.com) [local](/pricing) [http](http://plain.test)",
    ].join("\n");
    expect(extractHttpLinks(body)).toEqual(["https://example.com/docs", "http://plain.test"]);
  });
});

describe("validateDraftLinks", () => {
  it("replaces an unverified link with an [add link] placeholder, keeping the anchor text", async () => {
    const check = checkerFor([]);
    const { body, replaced } = await validateDraftLinks("Read the [changelog](https://dead.test/x).", check);
    expect(body).toBe("Read the changelog [add link].");
    expect(replaced).toEqual(["https://dead.test/x"]);
  });

  it("leaves verified links untouched", async () => {
    const check = checkerFor(["https://live.test/ok"]);
    const input = "Try [it](https://live.test/ok) now.";
    const { body, replaced } = await validateDraftLinks(input, check);
    expect(body).toBe(input);
    expect(replaced).toEqual([]);
  });

  it("replaces only the dead link when a body mixes live and dead links", async () => {
    const check = checkerFor(["https://live.test"]);
    const { body, replaced } = await validateDraftLinks(
      "[good](https://live.test) and [bad](https://gone.test)",
      check
    );
    expect(body).toBe("[good](https://live.test) and bad [add link]");
    expect(replaced).toEqual(["https://gone.test"]);
  });

  it("uses a bare placeholder when the dead link has no anchor text", async () => {
    const { body } = await validateDraftLinks("x [](https://gone.test) y", checkerFor([]));
    expect(body).toBe("x [add link] y");
  });

  it("never probes or rewrites images, anchors, or relative links", async () => {
    const check = checkerFor([]);
    const input = "![img](https://cdn.test/a.png) [anchor](#top) [rel](/docs)";
    const { body, replaced } = await validateDraftLinks(input, check);
    expect(body).toBe(input);
    expect(replaced).toEqual([]);
    expect(check).not.toHaveBeenCalled();
  });

  it("checks each unique URL once even when it appears multiple times", async () => {
    const check = checkerFor([]);
    await validateDraftLinks("[a](https://gone.test) [b](https://gone.test)", check);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("returns the body unchanged when there are no links", async () => {
    const check = checkerFor([]);
    const { body, replaced } = await validateDraftLinks("Just prose, no links.", check);
    expect(body).toBe("Just prose, no links.");
    expect(replaced).toEqual([]);
    expect(check).not.toHaveBeenCalled();
  });
});
