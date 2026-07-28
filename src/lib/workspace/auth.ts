import type { NextAuthOptions, Session } from "next-auth";
import GithubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import type { JWT } from "next-auth/jwt";
import { getOrCreateUserFromOAuth, type OAuthProvider } from "./tenant-bootstrap";
import { mapOAuthProfile } from "./oauth-profile";

const providers: NextAuthOptions["providers"] = [
  GithubProvider({
    clientId: process.env.GITHUB_CLIENT_ID as string,
    clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
  }),
];

// Only offer Google when it's configured, so unset env doesn't 500 the button.
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  providers.push(
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    })
  );
}

export const authOptions: NextAuthOptions = {
  providers,
  session: { strategy: "jwt" },
  pages: { signIn: "/signin" },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account && profile) {
        const input = mapOAuthProfile(account.provider as OAuthProvider, profile);
        const { userId, tenantId, role } = await getOrCreateUserFromOAuth(input);
        token.userId = userId;
        token.tenantId = tenantId;
        token.role = role;
      }
      return token;
    },
    async session({ session, token }: { session: Session; token: JWT }) {
      session.user.id = token.userId;
      // "" / "member" are placeholders for a workspace-less token. requireSession()
      // overwrites both from real membership rows on every request and is the only
      // sanctioned way to obtain a session, so nothing should ever read these.
      // They fail closed if something does: "" is not a valid uuid, so a
      // tenant-scoped query built from it errors in Postgres rather than
      // silently matching another workspace's rows.
      session.user.tenantId = token.tenantId ?? "";
      session.user.role = token.role ?? "member";
      return session;
    },
  },
};
