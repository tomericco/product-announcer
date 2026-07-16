import { describe, it, expect } from "vitest";
import { resolvePersonaRefs, systemPersonaKeys } from "../../src/lib/personas";

const catalog = [
  { key: "developer", name: "Developer", brief: "cares about APIs" },
  { key: "product-manager", name: "Product Manager", brief: "cares about outcomes" },
];

describe("resolvePersonaRefs", () => {
  it("resolves system refs against the current catalog", () => {
    expect(resolvePersonaRefs([{ type: "system", key: "developer" }], catalog)).toEqual([
      { name: "Developer", brief: "cares about APIs" },
    ]);
  });

  it("passes custom personas through and drops nameless ones", () => {
    const refs = [
      { type: "custom" as const, name: "Founders", brief: "want the big picture" },
      { type: "custom" as const, name: "  ", brief: "no name" },
    ];
    expect(resolvePersonaRefs(refs, catalog)).toEqual([
      { name: "Founders", brief: "want the big picture" },
    ]);
  });

  it("drops a system ref whose key is no longer in the catalog", () => {
    expect(resolvePersonaRefs([{ type: "system", key: "retired-persona" }], catalog)).toEqual([]);
  });

  it("preserves order across mixed refs", () => {
    const refs = [
      { type: "system" as const, key: "product-manager" },
      { type: "custom" as const, name: "Founders", brief: "big picture" },
      { type: "system" as const, key: "developer" },
    ];
    expect(resolvePersonaRefs(refs, catalog)).toEqual([
      { name: "Product Manager", brief: "cares about outcomes" },
      { name: "Founders", brief: "big picture" },
      { name: "Developer", brief: "cares about APIs" },
    ]);
  });

  it("carries the system persona description for system refs and leaves it unset for custom refs", () => {
    const catalogWithDesc = [
      { key: "developer", name: "Developer", brief: "cares about APIs", description: "Engineers who integrate" },
    ];
    expect(resolvePersonaRefs([{ type: "system", key: "developer" }], catalogWithDesc)).toEqual([
      { name: "Developer", brief: "cares about APIs", description: "Engineers who integrate" },
    ]);

    const [custom] = resolvePersonaRefs([{ type: "custom", name: "Ops", brief: "runs infra" }], catalogWithDesc);
    expect(custom).toEqual({ name: "Ops", brief: "runs infra" });
    expect(custom.description).toBeUndefined();
  });
});

describe("systemPersonaKeys", () => {
  it("returns keys of system refs and ignores custom refs", () => {
    const keys = systemPersonaKeys([
      { type: "system", key: "developer" },
      { type: "custom", name: "Ops", brief: "runs infra" },
      { type: "system", key: "product-manager" },
    ]);
    expect(keys).toEqual(["developer", "product-manager"]);
  });

  it("returns an empty array for no refs or only custom refs", () => {
    expect(systemPersonaKeys([])).toEqual([]);
    expect(systemPersonaKeys([{ type: "custom", name: "Ops", brief: "x" }])).toEqual([]);
  });
});
