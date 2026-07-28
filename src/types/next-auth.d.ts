import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      tenantId: string;
      role: "owner" | "member";
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    userId: string;
    // Null when the account has no workspace (personal-email signup). Session
    // stays non-null: requireSession() is its only sanctioned producer and it
    // redirects rather than returning a workspace-less session.
    tenantId: string | null;
    role: "owner" | "member" | null;
  }
}
