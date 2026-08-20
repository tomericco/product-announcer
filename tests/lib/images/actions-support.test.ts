import { describe, it, expect } from "vitest";
import {
  editPromptHistory,
  validateUploadFile,
  altFromConcept,
  sliceAroundHeading,
  stripImageFromMarkdown,
  imageSlug,
  sizeForRole,
  selectionImageConcept,
  selectionImageLabel,
  SELECTION_CONTEXT_LIMIT,
  UPLOAD_MAX_BYTES,
} from "../../../src/lib/images/actions-support";
import { NON_LITERAL_DIRECTIVE } from "../../../src/lib/images/prompt";
import { slugForImage, validateUploadFile as validateFromBlob } from "../../../src/lib/images/blob";

describe("editPromptHistory", () => {
  it("appends the instruction as an Edit line after a blank line", () => {
    expect(editPromptHistory("A blue orb.\n", "  make it darker ")).toBe("A blue orb.\n\nEdit: make it darker");
  });
  it("chains a second edit after the first", () => {
    const once = editPromptHistory("A blue orb.", "darker");
    expect(editPromptHistory(once, "no people")).toBe("A blue orb.\n\nEdit: darker\n\nEdit: no people");
  });
});

describe("validateUploadFile", () => {
  it("is Plan 1's function, re-exported — not a second copy of the rules", () => {
    // Product owner decision 3: one definition of what may be uploaded, shared
    // by the editor and the Visual identity card.
    expect(validateUploadFile).toBe(validateFromBlob);
  });
  it("accepts png, jpeg and webp under the cap", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      expect(validateUploadFile({ type, size: 1024 })).toEqual({ ok: true });
    }
  });
  it("rejects other mime types with a readable error", () => {
    const r = validateUploadFile({ type: "image/gif", size: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/PNG, JPEG or WebP/);
  });
  it("rejects files over 10 MB", () => {
    const r = validateUploadFile({ type: "image/png", size: UPLOAD_MAX_BYTES + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/10 MB/);
  });
});

describe("altFromConcept", () => {
  it("takes the first sentence, drops a leading 'image of', and caps at 125 chars", () => {
    expect(altFromConcept("Image of a rocket launching from a laptop. Second sentence.")).toBe(
      "A rocket launching from a laptop"
    );
    const long = "x".repeat(200);
    expect(altFromConcept(long).length).toBeLessThanOrEqual(125);
  });
  it("returns an empty string for an empty concept", () => {
    expect(altFromConcept("   ")).toBe("");
  });
});

describe("sliceAroundHeading", () => {
  const md = [
    "# Title",
    "",
    "Intro paragraph.",
    "",
    "## Search",
    "",
    "Search is faster now.",
    "",
    "### Details",
    "",
    "Indexing changed.",
    "",
    "## Billing",
    "",
    "Billing moved.",
  ].join("\n");

  it("returns the section under the named heading up to the next heading of the same or higher level", () => {
    const out = sliceAroundHeading(md, "Search");
    expect(out.startsWith("## Search")).toBe(true);
    expect(out).toContain("### Details");
    expect(out).toContain("Indexing changed.");
    expect(out).not.toContain("## Billing");
  });
  it("matches the heading case-insensitively and trims", () => {
    expect(sliceAroundHeading(md, "  billing ")).toContain("Billing moved.");
  });
  it("falls back to the head of the document when the heading is null or not found", () => {
    expect(sliceAroundHeading(md, null).startsWith("# Title")).toBe(true);
    expect(sliceAroundHeading(md, "Nope").startsWith("# Title")).toBe(true);
  });
  it("caps the slice at maxChars", () => {
    expect(sliceAroundHeading(md, "Search", 12).length).toBeLessThanOrEqual(12);
  });
});

describe("stripImageFromMarkdown", () => {
  it("removes image lines whose URL is in the list and collapses the blank line they leave", () => {
    const md = "## A\n\n![alt](https://x/a.png)\n\nText.\n\n![keep](https://x/b.png)\n";
    expect(stripImageFromMarkdown(md, ["https://x/a.png"])).toBe("## A\n\nText.\n\n![keep](https://x/b.png)\n");
  });
  it("removes an inline image reference inside a paragraph without touching the rest", () => {
    const md = "See ![alt](https://x/a.png) here.";
    expect(stripImageFromMarkdown(md, ["https://x/a.png"])).toBe("See  here.");
  });
  it("is a no-op when nothing matches", () => {
    const md = "![alt](https://x/a.png)";
    expect(stripImageFromMarkdown(md, ["https://x/zzz.png"])).toBe(md);
  });
});

describe("imageSlug and sizeForRole", () => {
  it("slugifies to at most 40 chars with a fallback", () => {
    expect(imageSlug("A Rocket Launching From A Laptop, At Dawn, With Confetti")).toBe(
      "a-rocket-launching-from-a-laptop-at-dawn"
    );
    expect(imageSlug("!!!")).toBe("image");
  });
  it("agrees with slugForImage — one slug rule reaches imagePathname, not two", () => {
    for (const text of ["A Rocket", "!!!", "x".repeat(100), "Ünïcödé Ttitle", "  "]) {
      expect(imageSlug(text)).toBe(slugForImage(text));
    }
  });
  it("cannot escape the pathname directory (uploaded file names reach it verbatim)", () => {
    // `uploadImageFile` builds its slug from the browser-supplied file name.
    for (const hostile of ["../../etc/passwd", "a/b/c.png", "x?y=z"]) {
      expect(imageSlug(hostile)).toMatch(/^[a-z0-9-]+$/);
    }
  });
  it("maps roles to render sizes", () => {
    expect(sizeForRole("cover")).toBe("1200x624");
    expect(sizeForRole("body")).toBe("1200x896");
    expect(sizeForRole("library")).toBe("1200x896");
  });
});

describe("selectionImageConcept", () => {
  it("makes the passage the brief and the post title its context", () => {
    const concept = selectionImageConcept({ title: "Shipping faster", selection: "Handoffs are where releases stall." });

    expect(concept).toContain('from the post "Shipping faster"');
    expect(concept).toContain('"Handoffs are where releases stall."');
  });

  it("carries the house non-literal rule itself, since nothing else translates this brief", () => {
    // This one goes straight to the image model with the content quoted
    // verbatim — no concept agent in between — so the rule has to travel
    // with it, not just live in the agents.
    const concept = selectionImageConcept({ title: "T", selection: "We moved validation upstream." });

    expect(concept).toContain(NON_LITERAL_DIRECTIVE);
  });

  it("layers what the user typed on top of the passage rather than replacing it", () => {
    // The whole point of the default: typing a direction refines the passage,
    // it does not become the entire brief.
    const concept = selectionImageConcept({
      title: "Shipping faster",
      selection: "Handoffs are where releases stall.",
      instruction: "show it as a relay race",
    });

    expect(concept).toContain("Handoffs are where releases stall.");
    expect(concept).toContain("Direction: show it as a relay race");
  });

  it("falls back to the typed instruction alone when there is no passage", () => {
    expect(selectionImageConcept({ title: "T", selection: "   ", instruction: "a lighthouse" })).toBe("a lighthouse");
    expect(selectionImageConcept({ title: "T", selection: "" })).toBe("");
  });

  it("omits the title clause entirely when the piece is untitled", () => {
    const concept = selectionImageConcept({ title: "  ", selection: "Some text." });

    expect(concept).toContain('this passage: "Some text."');
    expect(concept).not.toContain("from the post");
  });

  it("flattens markdown so a blob URL is never read as part of the subject", () => {
    const concept = selectionImageConcept({
      title: "T",
      selection: "## A heading\n\n![alt](https://blob.example/x.png)\n\nSee **the [docs](https://example.com/docs)**.",
    });

    expect(concept).not.toContain("blob.example");
    expect(concept).not.toContain("https://example.com/docs");
    expect(concept).not.toContain("#");
    expect(concept).not.toContain("**");
    // The link's own words survive; only its target is dropped.
    expect(concept).toContain("See the docs.");
  });

  it("caps a long passage so the concept can't drown the style block after it", () => {
    const concept = selectionImageConcept({ title: "T", selection: "word ".repeat(2000) });

    // The quoted passage is what's capped; the fixed directive that follows
    // it is a known constant, so measure the variable part.
    expect(concept.length - NON_LITERAL_DIRECTIVE.length).toBeLessThan(SELECTION_CONTEXT_LIMIT + 200);
  });
});

describe("selectionImageLabel", () => {
  it("keeps a short passage whole", () => {
    expect(selectionImageLabel("Handoffs are where releases stall.")).toBe("Handoffs are where releases stall.");
  });

  it("clips a long passage at a word boundary and marks the trim", () => {
    const label = selectionImageLabel("word ".repeat(50));

    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(81);
    expect(label).not.toMatch(/wor…$/); // clipped between words, not mid-word
  });

  it("clips mid-word rather than losing most of the label to a single long token", () => {
    // No space anywhere near the end: a word-boundary trim would throw away
    // almost everything, so the raw clip wins.
    const label = selectionImageLabel(`short ${"x".repeat(200)}`);

    expect(label.length).toBe(81);
  });

  it("flattens markdown the same way the concept does", () => {
    expect(selectionImageLabel("## Heading\n\n**Bold** text")).toBe("Heading Bold text");
  });
});
