import { describe, it, expect } from "vitest";
import { buildFieldData, validateMapping, suggestMapping } from "../../../../src/lib/integrations/webflow/mapping";
import type { WebflowField } from "../../../../src/lib/integrations/webflow/client";
import type { WebflowFieldMapping } from "../../../../src/db/schema";

const fields: WebflowField[] = [
  { id: "f1", slug: "name", displayName: "Name", type: "PlainText", isRequired: true },
  { id: "f2", slug: "slug", displayName: "Slug", type: "PlainText", isRequired: true },
  { id: "f3", slug: "post-body", displayName: "Post Body", type: "RichText", isRequired: false },
  { id: "f4", slug: "published-on", displayName: "Published On", type: "DateTime", isRequired: false },
  { id: "f5", slug: "author", displayName: "Author", type: "Reference", isRequired: true },
  { id: "f6", slug: "main-image", displayName: "Main Image", type: "Image", isRequired: false },
];

const update = {
  id: "u1",
  tenantId: "t1",
  title: "Faster Search",
  body: "# Hi\n\nWe shipped **search**.",
  publishedAt: new Date("2026-07-20T10:00:00Z"),
} as never;

describe("buildFieldData", () => {
  it("maps title, slug, body and date onto the customer's field slugs", () => {
    const mapping: WebflowFieldMapping = {
      name: { source: "title" },
      slug: { source: "slug" },
      "post-body": { source: "body" },
      "published-on": { source: "publishedAt" },
      author: { source: "static", value: "65f1abc" },
    };
    const data = buildFieldData(update, mapping, fields);
    expect(data.name).toBe("Faster Search");
    expect(data.slug).toBe("faster-search");
    expect(data["post-body"]).toContain("<strong>search</strong>");
    expect(data["published-on"]).toBe("2026-07-20T10:00:00.000Z");
    expect(data.author).toBe("65f1abc");
  });

  it("omits fields mapped to empty", () => {
    const mapping: WebflowFieldMapping = { name: { source: "title" }, "post-body": { source: "empty" } };
    const data = buildFieldData(update, mapping, fields);
    expect(data).not.toHaveProperty("post-body");
  });

  it("uses the slug override when retrying a collision", () => {
    const mapping: WebflowFieldMapping = { slug: { source: "slug" } };
    expect(buildFieldData(update, mapping, fields, { slugOverride: "faster-search-2" }).slug).toBe(
      "faster-search-2"
    );
  });

  it("ignores mappings for fields that no longer exist in the collection", () => {
    const mapping: WebflowFieldMapping = { name: { source: "title" }, "deleted-field": { source: "body" } };
    const data = buildFieldData(update, mapping, fields);
    expect(data).not.toHaveProperty("deleted-field");
  });

  it("emits { url, alt } for a coverImage mapping when a cover is supplied", () => {
    const mapping: WebflowFieldMapping = { "main-image": { source: "coverImage" } };
    const data = buildFieldData(update, mapping, fields, {
      cover: {
        url: "https://blob.example/cover.png",
        alt: "Lighthouse over a grid",
        width: 1200,
        height: 630,
        renderId: "render-1",
      },
    });
    expect(data["main-image"]).toEqual({ url: "https://blob.example/cover.png", alt: "Lighthouse over a grid" });
  });

  it("omits the key entirely for a coverImage mapping when the piece has no cover", () => {
    // Webflow 400s on `null` for an Image field; an absent key is "unchanged /
    // empty". findEmptyRequiredField in the destination treats an absent
    // required key as empty, so a required image field still fails clearly.
    const mapping: WebflowFieldMapping = { name: { source: "title" }, "main-image": { source: "coverImage" } };
    const data = buildFieldData(update, mapping, fields, { cover: null });
    expect(data).not.toHaveProperty("main-image");
    expect(data.name).toBe("Faster Search");
  });

  it("omits the coverImage key when no cover option is passed at all", () => {
    const mapping: WebflowFieldMapping = { "main-image": { source: "coverImage" } };
    expect(buildFieldData(update, mapping, fields)).not.toHaveProperty("main-image");
  });

  it("sends an empty alt as an empty string, not by dropping the key", () => {
    // An uploaded cover has `altText: ""` (spec §2, decorative). The Image
    // field itself is present and valid — only the alt is blank — so the key
    // must still be written, or `findEmptyRequiredField` would report a
    // required image field as empty when a perfectly good image exists.
    const mapping: WebflowFieldMapping = { "main-image": { source: "coverImage" } };
    const data = buildFieldData(update, mapping, fields, {
      cover: { url: "https://blob.example/u.png", alt: "", width: 1200, height: 630, renderId: "render-1" },
    });
    expect(data["main-image"]).toEqual({ url: "https://blob.example/u.png", alt: "" });
  });

  it("still maps every other source when a coverImage field is present but coverless", () => {
    // Regression guard for an early-`continue` in the coverImage branch: an
    // absent cover must skip ONE key, not abandon the rest of the loop.
    const mapping: WebflowFieldMapping = {
      name: { source: "title" },
      "main-image": { source: "coverImage" },
      "published-on": { source: "publishedAt" },
    };
    const data = buildFieldData(update, mapping, fields, { cover: null });
    expect(data).not.toHaveProperty("main-image");
    expect(data.name).toBe("Faster Search");
    expect(typeof data["published-on"]).toBe("string");
  });
});

describe("validateMapping", () => {
  it("passes when every required field is mapped", () => {
    const mapping: WebflowFieldMapping = {
      name: { source: "title" },
      slug: { source: "slug" },
      author: { source: "static", value: "65f1abc" },
    };
    expect(validateMapping(mapping, fields)).toEqual([]);
  });

  it("reports required fields with no mapping", () => {
    const problems = validateMapping({ name: { source: "title" } }, fields);
    expect(problems.join(" ")).toContain("Slug");
    expect(problems.join(" ")).toContain("Author");
  });

  it("reports a required field mapped to empty", () => {
    const mapping: WebflowFieldMapping = {
      name: { source: "title" },
      slug: { source: "slug" },
      author: { source: "empty" },
    };
    expect(validateMapping(mapping, fields).join(" ")).toContain("Author");
  });

  it("reports a static mapping with a blank value", () => {
    const mapping: WebflowFieldMapping = {
      name: { source: "title" },
      slug: { source: "slug" },
      author: { source: "static", value: "  " },
    };
    expect(validateMapping(mapping, fields).join(" ")).toContain("Author");
  });

  it("reports mapped fields missing from the collection", () => {
    const mapping: WebflowFieldMapping = {
      name: { source: "title" },
      slug: { source: "slug" },
      author: { source: "static", value: "x" },
      gone: { source: "body" },
    };
    expect(validateMapping(mapping, fields).join(" ")).toContain("gone");
  });

  it("accepts coverImage on an Image field", () => {
    const mapping: WebflowFieldMapping = {
      name: { source: "title" },
      slug: { source: "slug" },
      author: { source: "static", value: "65f1abc" },
      "main-image": { source: "coverImage" },
    };
    expect(validateMapping(mapping, fields)).toEqual([]);
  });

  it("rejects coverImage on a non-Image field, naming the field and its type", () => {
    const mapping: WebflowFieldMapping = {
      name: { source: "title" },
      slug: { source: "slug" },
      author: { source: "static", value: "65f1abc" },
      "post-body": { source: "coverImage" },
    };
    const problems = validateMapping(mapping, fields);
    expect(problems.join(" ")).toContain("Post Body");
    expect(problems.join(" ")).toContain("RichText");
  });
});

describe("suggestMapping", () => {
  it("pre-selects name, slug, the first rich text field and a date field", () => {
    const suggestion = suggestMapping(fields);
    expect(suggestion.name).toEqual({ source: "title" });
    expect(suggestion.slug).toEqual({ source: "slug" });
    expect(suggestion["post-body"]).toEqual({ source: "body" });
    expect(suggestion["published-on"]).toEqual({ source: "publishedAt" });
  });

  it("leaves fields it cannot infer unmapped", () => {
    expect(suggestMapping(fields).author).toBeUndefined();
  });

  it("only maps the first rich text field", () => {
    const twoRichText: WebflowField[] = [
      ...fields,
      { id: "f6", slug: "excerpt", displayName: "Excerpt", type: "RichText", isRequired: false },
    ];
    expect(suggestMapping(twoRichText).excerpt).toBeUndefined();
  });

  it("auto-maps the first Image field to coverImage", () => {
    expect(suggestMapping(fields)["main-image"]).toEqual({ source: "coverImage" });
  });

  it("only maps the first Image field", () => {
    const twoImages: WebflowField[] = [
      ...fields,
      { id: "f7", slug: "thumbnail", displayName: "Thumbnail", type: "Image", isRequired: false },
    ];
    expect(suggestMapping(twoImages).thumbnail).toBeUndefined();
  });

  it("does not map a MultiImage gallery to coverImage", () => {
    const gallery: WebflowField[] = [
      { id: "g1", slug: "gallery", displayName: "Gallery", type: "MultiImage", isRequired: false },
    ];
    expect(suggestMapping(gallery).gallery).toBeUndefined();
  });
});
