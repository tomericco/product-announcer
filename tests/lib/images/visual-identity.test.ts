import { describe, it, expect } from "vitest";
import type { VisualIdentity } from "../../../src/db/schema";
import {
  DEFAULT_VISUAL_IDENTITY,
  compileStyleBlock,
  isVisualIdentityReady,
  parseVisualIdentity,
} from "../../../src/lib/images/visual-identity";

const IDENTITY: VisualIdentity = {
  ...DEFAULT_VISUAL_IDENTITY,
  palette: [
    { hex: "#1a73e8", role: "primary" },
    { hex: "#fbbc04", role: "accent" },
    { hex: "#ffffff", role: "background" },
    { hex: "#5f6368", role: "neutral" },
  ],
  stylePreset: "geometric",
  moodWords: ["calm", "precise"],
  customStyleDescriptors: "rounded corners everywhere",
  imageGenerationRules: [
    { kind: "do", text: "include the blue orb" },
    { kind: "dont", text: "no photorealism" },
    { kind: "dont", text: "no hands" },
  ],
  backgroundTreatment: "subtle_pattern",
  texture: "grain",
  peopleStyle: "none",
};

describe("DEFAULT_VISUAL_IDENTITY", () => {
  it("matches the spec defaults", () => {
    expect(DEFAULT_VISUAL_IDENTITY.stylePreset).toBe("flat");
    expect(DEFAULT_VISUAL_IDENTITY.moodWords).toEqual(["clean", "modern"]);
    expect(DEFAULT_VISUAL_IDENTITY.allowTextInImages).toBe(false);
    expect(DEFAULT_VISUAL_IDENTITY.styleReferenceImages).toEqual([]);
    expect(DEFAULT_VISUAL_IDENTITY.customStyleDescriptors).toBe("");
    expect(DEFAULT_VISUAL_IDENTITY.imageGenerationRules).toEqual([
      { kind: "dont", text: "no photorealism" },
      { kind: "dont", text: "no stock-photo look" },
      { kind: "dont", text: "no 3D render" },
      { kind: "dont", text: "no clip-art" },
    ]);
    expect(DEFAULT_VISUAL_IDENTITY.backgroundTreatment).toBe("solid");
    expect(DEFAULT_VISUAL_IDENTITY.texture).toBe("none");
    expect(DEFAULT_VISUAL_IDENTITY.peopleStyle).toBe("abstract_figures");
    expect(DEFAULT_VISUAL_IDENTITY.pinStyleToCover).toBe(true);
  });
});

describe("compileStyleBlock", () => {
  it("is one paragraph containing preset words, palette with roles, mood, background, texture, people, descriptors and rules", () => {
    const block = compileStyleBlock(IDENTITY);
    expect(block).not.toContain("\n");
    expect(block).toContain("geometric");
    expect(block).toContain("#1a73e8 as the primary");
    expect(block).toContain("#ffffff as the background");
    expect(block).toContain("#fbbc04 as an accent");
    expect(block).toContain("#5f6368 as a neutral");
    expect(block).toContain("calm, precise");
    expect(block).toContain("subtle");
    expect(block).toContain("grain");
    expect(block).toContain("no people");
    expect(block).toContain("rounded corners everywhere");
    expect(block).toContain("Always: include the blue orb.");
    expect(block).toContain("Never: no photorealism; no hands.");
  });

  it("is deterministic and omits Always when there are no do rules", () => {
    const vi = { ...IDENTITY, imageGenerationRules: [{ kind: "dont" as const, text: "no clip-art" }] };
    expect(compileStyleBlock(vi)).toBe(compileStyleBlock(vi));
    expect(compileStyleBlock(vi)).not.toContain("Always:");
    expect(compileStyleBlock(vi)).toContain("Never: no clip-art.");
  });

  it("omits the descriptors clause when empty and the rules when there are none", () => {
    const vi = { ...IDENTITY, customStyleDescriptors: "", imageGenerationRules: [] };
    const block = compileStyleBlock(vi);
    expect(block).not.toContain("Always:");
    expect(block).not.toContain("Never:");
    expect(block).not.toContain("rounded corners");
  });

  it("omits the palette clause entirely for an empty palette, and stays one line", () => {
    // Generation is gated on `isVisualIdentityReady`, but the editor compiles a
    // preview from a half-filled card, so an empty palette must not emit
    // "Palette, used strictly: ." — an empty instruction the model may honour.
    const block = compileStyleBlock({ ...IDENTITY, palette: [] });
    expect(block).not.toContain("Palette");
    expect(block).not.toContain("\n");
    expect(block).toContain("Style:");
  });

  it("names all six colours, ordered by role, when the palette is full", () => {
    const full = {
      ...IDENTITY,
      palette: [
        { hex: "#111111", role: "neutral" as const },
        { hex: "#222222", role: "accent" as const },
        { hex: "#333333", role: "secondary" as const },
        { hex: "#444444", role: "primary" as const },
        { hex: "#555555", role: "background" as const },
        { hex: "#666666", role: "accent" as const },
      ],
    };
    const block = compileStyleBlock(full);
    for (const hex of ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666"]) {
      expect(block).toContain(hex);
    }
    // ROLE_ORDER puts background first and neutral last.
    expect(block.indexOf("#555555")).toBeLessThan(block.indexOf("#444444"));
    expect(block.indexOf("#444444")).toBeLessThan(block.indexOf("#111111"));
  });

  it("stays one line even when a descriptor or a rule was typed with newlines", () => {
    // `customStyleDescriptors` is a <Textarea> and rule text is free input, so
    // both can carry newlines. The compiled block is embedded verbatim in the
    // stored render prompt; a multi-line style block is not what buildImagePrompt
    // documents it produces.
    const block = compileStyleBlock({
      ...IDENTITY,
      customStyleDescriptors: "rounded corners\neverywhere",
      imageGenerationRules: [{ kind: "dont", text: "no\nhands" }],
    });
    expect(block).not.toContain("\n");
  });

  it("lowercases hex in the compiled block regardless of how it was stored", () => {
    const block = compileStyleBlock({ ...IDENTITY, palette: [{ hex: "#1A73E8", role: "primary" }] });
    expect(block).toContain("#1a73e8");
    expect(block).not.toContain("#1A73E8");
  });
});

describe("isVisualIdentityReady", () => {
  it("needs three palette colors", () => {
    expect(isVisualIdentityReady(null)).toBe(false);
    expect(isVisualIdentityReady({ ...IDENTITY, palette: IDENTITY.palette.slice(0, 2) })).toBe(false);
    expect(isVisualIdentityReady({ ...IDENTITY, palette: IDENTITY.palette.slice(0, 3) })).toBe(true);
  });
});

describe("parseVisualIdentity", () => {
  it("accepts a full identity and normalises hex and whitespace", () => {
    const parsed = parseVisualIdentity({
      ...IDENTITY,
      palette: [{ hex: "#1A73E8 ", role: "primary" }],
      moodWords: [" Calm ", "", "precise"],
      customStyleDescriptors: "  rounded  ",
      imageGenerationRules: [{ kind: "do", text: "  keep it  " }, { kind: "dont", text: "" }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.palette).toEqual([{ hex: "#1a73e8", role: "primary" }]);
    expect(parsed!.moodWords).toEqual(["Calm", "precise"]);
    expect(parsed!.customStyleDescriptors).toBe("rounded");
    expect(parsed!.imageGenerationRules).toEqual([{ kind: "do", text: "keep it" }]);
  });

  it("rejects bad hex, unknown presets, too many colors, over-long descriptors, non-URL references", () => {
    expect(parseVisualIdentity({ ...IDENTITY, palette: [{ hex: "blue", role: "primary" }] })).toBeNull();
    expect(parseVisualIdentity({ ...IDENTITY, stylePreset: "photoreal" })).toBeNull();
    expect(
      parseVisualIdentity({ ...IDENTITY, palette: Array.from({ length: 7 }, () => ({ hex: "#000000", role: "neutral" })) })
    ).toBeNull();
    expect(parseVisualIdentity({ ...IDENTITY, customStyleDescriptors: "x".repeat(201) })).toBeNull();
    expect(parseVisualIdentity({ ...IDENTITY, styleReferenceImages: ["not a url"] })).toBeNull();
    expect(parseVisualIdentity({ ...IDENTITY, styleReferenceImages: Array(5).fill("https://a.b/c.png") })).toBeNull();
    expect(parseVisualIdentity("nope")).toBeNull();
  });

  it("allows an empty palette (a draft the user is still building)", () => {
    expect(parseVisualIdentity({ ...IDENTITY, palette: [] })?.palette).toEqual([]);
  });

  it("restricts styleReferenceImages to this app's private blob-storage host", () => {
    // Only `https://<store-id>.private.blob.vercel-storage.com/…` — the host
    // `uploadBrandAsset`/`put({access:"private"})` actually returns. Brand
    // assets are private (unlike content images), so this is a DIFFERENT
    // host than the public content store. `saveVisualIdentity` persists this
    // array verbatim and `removeStyleReference` later deletes by a pathname
    // derived from it, so any other host must be rejected here, not trusted
    // as "some URL".
    const valid = "https://abc123.private.blob.vercel-storage.com/tenants/t1/brand/logo-xyz.png";
    expect(parseVisualIdentity({ ...IDENTITY, styleReferenceImages: [valid] })?.styleReferenceImages).toEqual([valid]);

    expect(parseVisualIdentity({ ...IDENTITY, styleReferenceImages: ["https://evil.example.com/logo.png"] })).toBeNull();
    expect(
      parseVisualIdentity({ ...IDENTITY, styleReferenceImages: ["http://abc123.private.blob.vercel-storage.com/logo.png"] })
    ).toBeNull();
    // The public content-store host is no longer a valid host for a style
    // reference — brand assets and content images are different stores now.
    expect(
      parseVisualIdentity({ ...IDENTITY, styleReferenceImages: ["https://abc123.public.blob.vercel-storage.com/logo.png"] })
    ).toBeNull();
  });
});
