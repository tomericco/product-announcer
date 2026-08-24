import { describe, it, expect } from "vitest";
import {
  buildAliases,
  mentionsBrand,
  stripPromptEcho,
  stripUrls,
} from "../../../src/lib/ai-visibility/aliases";

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

describe("buildAliases, the names that are not 'Acme Inc'", () => {
  it("only strips a legal suffix that stands as its own word", () => {
    // The separator in the pattern is what saves these: without it "Company"
    // would lose its "co" and every answer containing "compan" would match.
    expect(buildAliases("Company")).toEqual(["Company"]);
    expect(buildAliases("Incident.io")).toEqual(["Incident.io", "Incident"]);
    expect(buildAliases("Corporate Ladder")).toEqual(["Corporate Ladder"]);
  });

  it("strips a legal suffix that ends in a full stop", () => {
    expect(buildAliases("Acme Corp.")).toEqual(["Acme Corp.", "Acme"]);
    expect(buildAliases("Acme Ltd.")).toEqual(["Acme Ltd.", "Acme"]);
    expect(buildAliases("Acme L.L.C.")).toEqual(["Acme L.L.C.", "Acme"]);
  });

  it("peels a brand TLD and a legal suffix off the same name, keeping both forms", () => {
    // Three spellings an engine might use, canonical first.
    expect(buildAliases("Acme.io, Inc.")).toEqual(["Acme.io, Inc.", "Acme.io", "Acme"]);
  });

  it("keeps punctuation, digits and non-ASCII letters in the name itself", () => {
    expect(buildAliases("Ben & Jerry's")).toEqual(["Ben & Jerry's"]);
    expect(buildAliases("Yahoo!")).toEqual(["Yahoo!"]);
    expect(buildAliases("C++")).toEqual(["C++"]);
    expect(buildAliases("Acme-Corp")).toEqual(["Acme-Corp"]);
    expect(buildAliases("37signals")).toEqual(["37signals"]);
    expect(buildAliases("Zoë")).toEqual(["Zoë"]);
  });

  it("drops a trailing comma or apostrophe, and anything under two characters", () => {
    expect(buildAliases("Acme,")).toEqual(["Acme"]);
    expect(buildAliases("Acme’")).toEqual(["Acme"]);
    // Two characters is the floor: a single letter matches somewhere in every
    // answer ever written, so a one-letter brand is better measured as absent
    // than as present in all 360 samples.
    expect(buildAliases("Vi")).toEqual(["Vi"]);
    expect(buildAliases("A")).toEqual([]);
    expect(buildAliases("A,")).toEqual([]);
  });
});

describe("stripPromptEcho", () => {
  it("removes the question wherever the engine restated it", () => {
    expect(stripPromptEcho("Q: What is Acme? A: it is a tracker.", "What is Acme?")).not.toContain(
      "What is Acme?"
    );
    expect(stripPromptEcho("What is Acme? Yes. What is Acme?", "What is Acme?").trim()).toBe("Yes.");
  });

  it("matches the echo whatever its case or line wrapping", () => {
    expect(stripPromptEcho("what IS acme? Yes.", "What is Acme?").trim()).toBe("Yes.");
    expect(stripPromptEcho("What is\n  Acme?\n\nYes.", "What is Acme?").trim()).toBe("Yes.");
  });

  it("survives regex metacharacters in the prompt instead of throwing", () => {
    // Prompts are tenant-written free text. An unescaped "(" here would be a
    // SyntaxError thrown out of extraction, losing the whole sample.
    const prompt = "What is Acme (the tracker) — $10/mo? [2026]";
    expect(stripPromptEcho(`${prompt} Several options exist.`, prompt).trim()).toBe(
      "Several options exist."
    );
  });

  it("is a no-op for an empty prompt", () => {
    expect(stripPromptEcho("hello", "")).toBe("hello");
    expect(stripPromptEcho("hello", "   ")).toBe("hello");
  });
});

describe("mentionsBrand, the false positives that would inflate the headline number", () => {
  it("does not match a brand that is a prefix of a longer word", () => {
    // The named case from the spec: "Notional" is not "Notion", and mention
    // rate is the one number this whole feature reports.
    expect(mentionsBrand("Notional Systems is unrelated.", buildAliases("Notion"))).toBe(false);
    expect(mentionsBrand("Notions of design are unrelated.", buildAliases("Notion"))).toBe(false);
    expect(mentionsBrand("Notion is a strong choice.", buildAliases("Notion"))).toBe(true);
  });

  it("keeps a digit at the end of a name from bleeding into the next one", () => {
    expect(mentionsBrand("Cloud99 is unrelated.", buildAliases("Cloud9"))).toBe(false);
    expect(mentionsBrand("Cloud9 is worth a look.", buildAliases("Cloud9"))).toBe(true);
  });

  it("anchors on letters and numbers, so punctuation next door still counts", () => {
    const aliases = buildAliases("Acme");
    expect(mentionsBrand("Acme-Corp announced a raise.", aliases)).toBe(true);
    expect(mentionsBrand("(Acme)", aliases)).toBe(true);
    expect(mentionsBrand("Acme", aliases)).toBe(true);
    expect(mentionsBrand("...Acme.", aliases)).toBe(true);
  });

  it("handles a name with regex metacharacters or non-ASCII letters", () => {
    expect(mentionsBrand("C++ is a language.", buildAliases("C++"))).toBe(true);
    expect(mentionsBrand("Zoë’s pricing starts at $10.", buildAliases("Zoë"))).toBe(true);
    expect(mentionsBrand("Yahoo! still exists.", buildAliases("Yahoo!"))).toBe(true);
  });

  it("ignores the brand when it only appears inside a link", () => {
    const aliases = buildAliases("Acme");
    expect(mentionsBrand("Sources: https://g2.com/search?q=acme", aliases)).toBe(false);
    expect(mentionsBrand("See <https://acme.com/pricing>.", aliases)).toBe(false);
    expect(mentionsBrand("Sources: HTTPS://ACME.COM/PRICING", aliases)).toBe(false);
    // A bare host with a path is a link; the same host with no path is how a
    // company writes its own name, and that must still count.
    expect(mentionsBrand("Sources: acme.io/pricing", buildAliases("Acme.io"))).toBe(false);
    expect(mentionsBrand("Acme.io is worth a look.", buildAliases("Acme.io"))).toBe(true);
  });

  it("ignores the brand when it only appears inside an echoed prompt with regex characters", () => {
    const prompt = "Is Acme (the tracker) worth $10/mo?";
    expect(mentionsBrand(`${prompt}\n\nSeveral options exist.`, buildAliases("Acme"), prompt)).toBe(
      false
    );
    expect(
      mentionsBrand(`${prompt}\n\nYes — Acme is a strong choice.`, buildAliases("Acme"), prompt)
    ).toBe(true);
  });
});
