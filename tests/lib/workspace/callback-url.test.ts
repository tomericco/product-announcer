import { describe, it, expect } from "vitest";
import { safeCallbackUrl } from "../../../src/lib/workspace/callback-url";

describe("safeCallbackUrl", () => {
  it("keeps an ordinary in-app path", () => {
    expect(safeCallbackUrl("/drafts")).toBe("/drafts");
    expect(safeCallbackUrl("/drafts?id=1")).toBe("/drafts?id=1");
  });

  it("falls back to the root when absent", () => {
    expect(safeCallbackUrl(undefined)).toBe("/");
    expect(safeCallbackUrl("")).toBe("/");
  });

  // The bug: NextAuth's /api/auth/signin bounces to /signin?callbackUrl=<that
  // URL>, so a successful sign-in redirected straight back to the sign-in page.
  it("rejects NextAuth's own auth routes, absolute or relative", () => {
    expect(safeCallbackUrl("/api/auth/signin")).toBe("/");
    expect(safeCallbackUrl("http://localhost:3100/api/auth/signin")).toBe("/");
    expect(safeCallbackUrl("/api/auth/signout")).toBe("/");
    expect(safeCallbackUrl("/api/auth")).toBe("/");
  });

  it("rejects the sign-in page itself", () => {
    expect(safeCallbackUrl("/signin")).toBe("/");
  });

  it("does not let an off-site origin through", () => {
    expect(safeCallbackUrl("//evil.com/pwned")).toBe("/");
    expect(safeCallbackUrl("https://evil.com/pwned")).toBe("/pwned");
    expect(safeCallbackUrl("not a url")).toBe("/");
  });

  it("leaves lookalike paths alone", () => {
    expect(safeCallbackUrl("/api/authors")).toBe("/api/authors");
    expect(safeCallbackUrl("/signin-help")).toBe("/signin-help");
  });
});
