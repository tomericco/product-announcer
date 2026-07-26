import type { OAuthProvider, OAuthUserInput } from "./tenant-bootstrap";

/**
 * Extract the fields the bootstrap needs from a raw NextAuth provider profile.
 * Kept as a pure function so provider quirks are unit-testable without NextAuth.
 *
 * GitHub: NextAuth's GithubProvider resolves the user's *verified primary*
 * email, so a GitHub email is treated as verified. Google supplies an explicit
 * `email_verified` boolean which we pass through for the bootstrap to gate on.
 */
export function mapOAuthProfile(provider: OAuthProvider, profile: unknown): OAuthUserInput {
  const p = (profile ?? {}) as Record<string, unknown>;
  const email = typeof p.email === "string" ? p.email : undefined;
  if (!email) {
    throw new Error(
      `${provider} sign-in did not return an email address. Make your email public / grant email access and try again.`
    );
  }
  const name = typeof p.name === "string" ? p.name : null;

  if (provider === "google") {
    return {
      email,
      emailVerified: p.email_verified === true,
      name,
      provider,
      providerAccountId: String(p.sub ?? ""),
    };
  }
  // github
  return {
    email,
    emailVerified: true,
    name,
    provider,
    providerAccountId: String(p.id ?? ""),
  };
}
