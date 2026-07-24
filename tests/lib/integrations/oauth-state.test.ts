import { describe, it, expect } from "vitest";
import {
  newStateNonce,
  buildOAuthState,
  parseOAuthState,
} from "../../../src/lib/integrations/oauth-state";

describe("oauth-state helper", () => {
  it("round-trips tenantId / returnTo / nonce through build + parse", () => {
    const nonce = newStateNonce();
    const state = buildOAuthState("tenant-123", "integrations", nonce);
    const parsed = parseOAuthState(state);
    expect(parsed).toEqual({ tenantId: "tenant-123", returnTo: "integrations", nonce });
  });

  it("parseOAuthState defaults every field to '' for null/empty input", () => {
    expect(parseOAuthState(null)).toEqual({ tenantId: "", returnTo: "", nonce: "" });
    expect(parseOAuthState("")).toEqual({ tenantId: "", returnTo: "", nonce: "" });
  });

  it("newStateNonce returns a 32-char hex string", () => {
    const nonce = newStateNonce();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("two nonces differ", () => {
    expect(newStateNonce()).not.toBe(newStateNonce());
  });
});
