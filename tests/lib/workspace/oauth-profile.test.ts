import { describe, it, expect } from "vitest";
import { mapOAuthProfile } from "../../../src/lib/workspace/oauth-profile";

describe("mapOAuthProfile", () => {
  it("maps a GitHub profile (email always treated as verified)", () => {
    const out = mapOAuthProfile("github", { id: 123, email: "a@b.com", name: "A" });
    expect(out).toEqual({ email: "a@b.com", emailVerified: true, name: "A", provider: "github", providerAccountId: "123" });
  });

  it("maps a verified Google profile", () => {
    const out = mapOAuthProfile("google", { sub: "g-1", email: "c@d.com", email_verified: true, name: "C" });
    expect(out).toEqual({ email: "c@d.com", emailVerified: true, name: "C", provider: "google", providerAccountId: "g-1" });
  });

  it("carries through Google email_verified=false", () => {
    const out = mapOAuthProfile("google", { sub: "g-2", email: "e@f.com", email_verified: false });
    expect(out.emailVerified).toBe(false);
  });

  it("throws when no email is present", () => {
    expect(() => mapOAuthProfile("github", { id: 1, name: "No Email" })).toThrow();
  });
});
