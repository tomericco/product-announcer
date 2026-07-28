import { describe, it, expect, afterEach } from "vitest";
import { isPersonalEmail } from "../../../src/lib/workspace/email-domain";

describe("isPersonalEmail", () => {
  afterEach(() => {
    delete process.env.ALLOWED_PERSONAL_EMAILS;
  });

  it("flags well-known personal providers", () => {
    expect(isPersonalEmail("someone@gmail.com")).toBe(true);
    expect(isPersonalEmail("someone@outlook.com")).toBe(true);
    expect(isPersonalEmail("someone@yahoo.co.uk")).toBe(true);
    expect(isPersonalEmail("someone@proton.me")).toBe(true);
    expect(isPersonalEmail("someone@qq.com")).toBe(true);
  });

  it("allows company domains", () => {
    expect(isPersonalEmail("tomer@frontitude.com")).toBe(false);
    expect(isPersonalEmail("dev@acme.io")).toBe(false);
  });

  it("normalises case and surrounding whitespace", () => {
    expect(isPersonalEmail("  Someone@GMAIL.com ")).toBe(true);
  });

  it("flags plus-addressed personal accounts", () => {
    expect(isPersonalEmail("someone+versional@gmail.com")).toBe(true);
  });

  // Matching is exact-domain-only, in both directions. A company subdomain is
  // not its parent, and a lookalike suffix is not the real provider.
  it("matches the domain exactly, never as a substring or suffix", () => {
    expect(isPersonalEmail("someone@mail.acme.com")).toBe(false);
    expect(isPersonalEmail("someone@gmail.com.evil.dev")).toBe(false);
    expect(isPersonalEmail("someone@notgmail.com")).toBe(false);
  });

  it("splits on the LAST @, so a quoted local part cannot spoof the domain", () => {
    expect(isPersonalEmail('"foo@acme.com"@gmail.com')).toBe(true);
  });

  it("lets an explicitly allowlisted address through", () => {
    process.env.ALLOWED_PERSONAL_EMAILS = "demo@gmail.com, other@yahoo.com";
    expect(isPersonalEmail("demo@gmail.com")).toBe(false);
    expect(isPersonalEmail("DEMO@GMAIL.COM")).toBe(false);
    expect(isPersonalEmail("someoneelse@gmail.com")).toBe(true);
  });

  it("reads the allowlist at call time, not at import time", () => {
    expect(isPersonalEmail("late@gmail.com")).toBe(true);
    process.env.ALLOWED_PERSONAL_EMAILS = "late@gmail.com";
    expect(isPersonalEmail("late@gmail.com")).toBe(false);
  });

  // Fails open: mapOAuthProfile already guarantees a provider-supplied address
  // and getOrCreateUserFromOAuth already rejects unverified ones, so there is no
  // path where a malformed string reaches a workspace.
  it("does not flag a malformed address with no domain", () => {
    expect(isPersonalEmail("no-at-sign")).toBe(false);
    expect(isPersonalEmail("")).toBe(false);
  });
});
