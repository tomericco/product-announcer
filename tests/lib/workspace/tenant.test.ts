import { describe, it, expect } from "vitest";
import { deriveDefaultTenantName } from "../../../src/lib/workspace/tenant";

describe("deriveDefaultTenantName", () => {
  it("capitalizes the domain label and appends Workspace", () => {
    expect(deriveDefaultTenantName("tomer@frontitude.com")).toBe("Frontitude's Workspace");
  });

  it("handles subdomains by using the first label", () => {
    expect(deriveDefaultTenantName("jane@eng.acme.io")).toBe("Eng's Workspace");
  });
});
