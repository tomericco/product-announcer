import { describe, it, expect } from "vitest";
import { buildAliases, mentionsBrand, stripUrls } from "../../../src/lib/ai-visibility/aliases";

describe("buildAliases", () => {
  it("keeps the name and adds the bare form", () => {
    expect(buildAliases("Acme")).toEqual(["Acme"]);
    expect(buildAliases("Acme Inc")).toEqual(["Acme Inc", "Acme"]);
    expect(buildAliases("Acme, Inc.")).toEqual(["Acme, Inc.", "Acme"]);
    expect(buildAliases("Acme GmbH")).toEqual(["Acme GmbH", "Acme"]);
    expect(buildAliases("Acme Pty Ltd")).toEqual(["Acme Pty Ltd", "Acme"]);
  });

  it("strips a brand TLD", () => {
    expect(buildAliases("Acme.io")).toEqual(["Acme.io", "Acme"]);
    expect(buildAliases("Acme.ai Inc")).toEqual(["Acme.ai Inc", "Acme.ai", "Acme"]);
  });

  it("does not strip a dot that is not a TLD, and drops what is too short", () => {
    expect(buildAliases("Acme.Systems")).toEqual(["Acme.Systems"]);
    expect(buildAliases("  ")).toEqual([]);
    expect(buildAliases("X")).toEqual([]);
  });

  it("collapses whitespace and never repeats an alias", () => {
    expect(buildAliases("  Acme   Inc  ")).toEqual(["Acme Inc", "Acme"]);
    expect(buildAliases("Inc")).toEqual(["Inc"]);
  });
});

describe("stripUrls", () => {
  it("removes links but leaves prose", () => {
    // The link becomes whitespace rather than nothing, so removing it can never
    // join the words either side of it — hence the whitespace-insensitive
    // comparison here.
    expect(stripUrls("See https://acme.com/pricing for more").replace(/\s+/g, " ").trim()).toBe(
      "See for more"
    );
    // ...and that anti-join property is the point of replacing with a space,
    // so prove it directly rather than trusting the normalised form above.
    expect(stripUrls("a https://x.com b")).not.toMatch(/\bab\b/);
    expect(stripUrls("a https://x.com b")).toMatch(/\ba\s+b\b/);
    // The same property where it actually bites: a stray tag between two words
    // must not fuse them into one, which would invent a word that was never
    // written — and could invent a brand name.
    expect(stripUrls("Acme<br>graph")).not.toMatch(/Acmegraph/);
    expect(stripUrls("[Acme](https://acme.com)")).not.toContain("https://acme.com");
    expect(stripUrls("visit www.acme.com today")).not.toContain("www.acme.com");
  });
});

describe("mentionsBrand", () => {
  const ALIASES = buildAliases("Acme Inc");

  it("finds the brand in prose, in any case, and possessive", () => {
    expect(mentionsBrand("Acme is a good fit for small teams.", ALIASES)).toBe(true);
    expect(mentionsBrand("acme is a good fit.", ALIASES)).toBe(true);
    expect(mentionsBrand("Acme's pricing starts at $10.", ALIASES)).toBe(true);
    expect(mentionsBrand("Acme’s pricing starts at $10.", ALIASES)).toBe(true);
    expect(mentionsBrand("Acme Inc has raised a Series A.", ALIASES)).toBe(true);
  });

  it("does not match a substring of another word", () => {
    expect(mentionsBrand("Acmegraph is unrelated.", ALIASES)).toBe(false);
    expect(mentionsBrand("The panacme approach.", ALIASES)).toBe(false);
  });

  it("does not match inside a URL", () => {
    expect(mentionsBrand("Sources: https://acme.com/pricing", ALIASES)).toBe(false);
    expect(mentionsBrand("See [the docs](https://docs.acme.com/start).", ALIASES)).toBe(false);
    expect(mentionsBrand("Sources: www.acme.com", ALIASES)).toBe(false);
    // But a real sentence alongside a link still counts.
    expect(mentionsBrand("Acme is worth a look: https://acme.com", ALIASES)).toBe(true);
  });

  it("does not match a scheme-less link, but keeps a dotted brand name in prose", () => {
    expect(mentionsBrand("Sources: acme.com/pricing", ALIASES)).toBe(false);
    expect(mentionsBrand("See acme.com/docs/start for setup.", ALIASES)).toBe(false);
    expect(mentionsBrand("Read more at docs.acme.com/guide.", ALIASES)).toBe(false);

    // The deliberate limit of the rule above: a company that brands itself as a
    // domain still gets counted when it appears as a NAME, with no path.
    const dotted = buildAliases("Acme.io");
    expect(mentionsBrand("Acme.io is a strong choice for small teams.", dotted)).toBe(true);
    expect(mentionsBrand("Sources: acme.io/pricing", dotted)).toBe(false);
  });

  it("does not match inside the echoed prompt", () => {
    const prompt = "Is Acme a good issue tracker for startups?";
    expect(mentionsBrand(`${prompt}\n\nThere are several good options.`, ALIASES, prompt)).toBe(
      false
    );
    expect(mentionsBrand(`Is Acme a good issue\ntracker for startups?\n\nYes.`, ALIASES, prompt)).toBe(
      false
    );
    expect(
      mentionsBrand(`${prompt}\n\nYes — Acme is a strong choice for small teams.`, ALIASES, prompt)
    ).toBe(true);
  });

  it("returns false for an empty alias list", () => {
    expect(mentionsBrand("Acme is great.", [])).toBe(false);
    expect(mentionsBrand("Acme is great.", ["", "x"])).toBe(false);
  });
});
