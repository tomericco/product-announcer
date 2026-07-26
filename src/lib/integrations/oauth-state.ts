import { randomBytes } from "node:crypto";

// A random, unguessable value bound to the browser via an httpOnly cookie, so a
// callback can prove the redirect belongs to the session that started the flow.
export function newStateNonce(): string {
  return randomBytes(16).toString("hex");
}

// state = `${tenantId}|${returnTo}|${nonce}`
export function buildOAuthState(tenantId: string, returnTo: string, nonce: string): string {
  return `${tenantId}|${returnTo}|${nonce}`;
}

export function parseOAuthState(state: string | null): { tenantId: string; returnTo: string; nonce: string } {
  const [tenantId = "", returnTo = "", nonce = ""] = (state ?? "").split("|");
  return { tenantId, returnTo, nonce };
}

// The cookie options used for every OAuth-state cookie. maxAge is short — the
// flow completes in seconds; a stale cookie should not linger.
export const OAUTH_STATE_COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 600,
};
