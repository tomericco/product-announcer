import type { NextAuthOptions, Session } from "next-auth";
import GithubProvider, { type GithubProfile } from "next-auth/providers/github";
import type { JWT } from "next-auth/jwt";
import { getOrCreateTenantForUser } from "./tenant-bootstrap";

export const authOptions: NextAuthOptions = {
  providers: [
    GithubProvider({
      clientId: process.env.GITHUB_CLIENT_ID as string,
      clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
    }),
  ],
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account && profile) {
        const githubProfile = profile as GithubProfile;
        const { userId, tenantId, role } = await getOrCreateTenantForUser({
          email: githubProfile.email ?? (token.email as string | undefined) ?? "",
          name: githubProfile.name,
          githubId: String(githubProfile.id),
        });
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
