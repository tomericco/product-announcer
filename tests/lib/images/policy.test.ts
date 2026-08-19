import { describe, it, expect } from "vitest";
import { contentTypeEnum } from "../../../src/db/schema";
import { DEFAULT_IMAGE_POLICY, resolveImagePolicy, parseImagePolicy } from "../../../src/lib/images/policy";

describe("DEFAULT_IMAGE_POLICY", () => {
  it("covers every content type in the enum — a new type must not fall through undefined", () => {
    // `resolveImagePolicy` does `policy?.[type] ?? DEFAULT_IMAGE_POLICY[type]`
    // and then reads `.body` off it. A ContentType missing from the defaults
    // throws at generation time, not here — so assert the table is total.
    for (const type of contentTypeEnum.enumValues) {
      expect(DEFAULT_IMAGE_POLICY[type]).toBeDefined();
      expect(resolveImagePolicy(null, type)).toEqual(
        expect.objectContaining({ cover: expect.any(Boolean), bodyCap: expect.any(Number) })
      );
      expect(resolveImagePolicy({}, type).bodyCap).toBeGreaterThanOrEqual(0);
    }
  });

  it("matches the spec table", () => {
    expect(DEFAULT_IMAGE_POLICY).toEqual({
      blog_post: { cover: true, body: "auto" },
      product_update: { cover: true, body: "off" },
      social_post: { cover: false, body: "off" },
    });
  });
});

describe("resolveImagePolicy", () => {
  it("falls back to defaults when the column is null or the type is missing", () => {
    expect(resolveImagePolicy(null, "blog_post")).toEqual({ cover: true, bodyCap: 3 });
    expect(resolveImagePolicy({}, "product_update")).toEqual({ cover: true, bodyCap: 0 });
    expect(resolveImagePolicy({ blog_post: { cover: false, body: 1 } }, "social_post")).toEqual({ cover: false, bodyCap: 0 });
  });

  it("maps auto to 3, off to 0 and a number to itself", () => {
    expect(resolveImagePolicy({ social_post: { cover: true, body: "auto" } }, "social_post")).toEqual({ cover: true, bodyCap: 3 });
    expect(resolveImagePolicy({ blog_post: { cover: false, body: "off" } }, "blog_post")).toEqual({ cover: false, bodyCap: 0 });
    expect(resolveImagePolicy({ blog_post: { cover: true, body: 2 } }, "blog_post")).toEqual({ cover: true, bodyCap: 2 });
  });
});

describe("parseImagePolicy", () => {
  it("accepts a valid partial policy", () => {
    expect(parseImagePolicy({ blog_post: { cover: true, body: 2 }, social_post: { cover: false, body: "off" } })).toEqual({
      blog_post: { cover: true, body: 2 },
      social_post: { cover: false, body: "off" },
    });
  });

  it("rejects unknown types, bad caps and non-objects", () => {
    expect(parseImagePolicy({ newsletter: { cover: true, body: "off" } })).toBeNull();
    expect(parseImagePolicy({ blog_post: { cover: true, body: 4 } })).toBeNull();
    expect(parseImagePolicy({ blog_post: { cover: "yes", body: "off" } })).toBeNull();
    expect(parseImagePolicy([])).toBeNull();
  });
});
