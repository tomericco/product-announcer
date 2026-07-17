import { describe, it, expect } from "vitest";
import type { Session } from "next-auth";
import { hasValidSession } from "../../../src/lib/workspace/session";

describe("hasValidSession", () => {
  it("returns false for a null session", () => {
    expect(hasValidSession(null)).toBe(false);
  });

  it("returns false when tenantId is missing", () => {
    const session = { user: {}, expires: "" } as unknown as Session;
    expect(hasValidSession(session)).toBe(false);
  });

  it("returns true when tenantId is present", () => {
    const session = { user: { tenantId: "tenant-1" }, expires: "" } as unknown as Session;
    expect(hasValidSession(session)).toBe(true);
  });
});
