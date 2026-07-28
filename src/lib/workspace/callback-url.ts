/**
 * Sanitise the `callbackUrl` the sign-in page forwards to NextAuth's `signIn()`.
 *
 * NextAuth persists whatever it is given in the callback-url cookie and reuses
 * it as the post-login destination. Feeding it an /api/auth/* route creates a
 * loop: sign-in succeeds, redirects to /api/auth/signin, which bounces back to
 * the sign-in page — so the user never reaches the app despite a valid session.
 *
 * Only same-site paths are allowed through. Anything absolute, protocol-relative,
 * or pointing back into the auth routes falls back to the app root.
 */
export function safeCallbackUrl(raw: string | undefined): string {
  const fallback = "/";
  if (!raw) return fallback;

  let path: string;
  if (raw.startsWith("/")) {
    // "//evil.com" is protocol-relative — an off-site redirect in disguise.
    if (raw.startsWith("//")) return fallback;
    path = raw;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return fallback;
    }
    // Absolute URLs are only safe once the caller's own origin check has run;
    // keep just the path so an off-site origin can never survive.
    path = `${parsed.pathname}${parsed.search}`;
  }

  const pathname = path.split(/[?#]/)[0];
  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return fallback;
  if (pathname === "/signin") return fallback;

  return path;
}
