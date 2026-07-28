"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

/**
 * Sign out first: without clearing the session the provider silently re-picks
 * the same personal account and the user loops back here.
 *
 * Uses NextAuth's `signOut`, not a plain <a href="/api/auth/signout">: a GET
 * to that route only renders NextAuth's unbranded confirmation interstitial
 * (a <form method="POST"> the user would have to submit separately).
 * `signOut()` does the CSRF-protected POST itself, then performs a real
 * full-page navigation to `callbackUrl` — see `user-menu.tsx` for the same
 * pattern. No SessionProvider is required for `signOut`.
 */
export function SignOutButton() {
  return (
    <Button className="w-full" onClick={() => signOut({ callbackUrl: "/signin" })}>
      Sign in with your work account
    </Button>
  );
}
