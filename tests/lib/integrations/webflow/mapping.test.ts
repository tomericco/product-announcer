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
    expect(buildFieldData(update, mapping, fields, "faster-search-2").slug).toBe("faster-search-2");
  });

  it("ignores mappings for fields that no longer exist in the collection", () => {
    const mapping: WebflowFieldMapping = { name: { source: "title" }, "deleted-field": { source: "body" } };
    const data = buildFieldData(update, mapping, fields);
    expect(data).not.toHaveProperty("deleted-field");
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
});
