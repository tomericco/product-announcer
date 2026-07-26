import type { NextAuthOptions, Session } from "next-auth";
import GithubProvider from "next-auth/providers/github";
import type { JWT } from "next-auth/jwt";
import { getOrCreateUserFromOAuth, type OAuthProvider } from "./tenant-bootstrap";
import { mapOAuthProfile } from "./oauth-profile";

export const authOptions: NextAuthOptions = {
  providers: [
    GithubProvider({
      clientId: process.env.GITHUB_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
    }),
  ],
  session: { strategy: "jwt" },
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
      session.user.tenantId = token.tenantId;
      session.user.role = token.role;
      return session;
    },
  },
};
