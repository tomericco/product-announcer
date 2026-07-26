"use client";

import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { acceptInvite } from "./accept-actions";

export function SignInToAccept({ token, googleEnabled }: { token: string; googleEnabled: boolean }) {
  const callbackUrl = `/invite/${token}`;
  return (
    <div className="flex flex-col gap-3">
      {googleEnabled && (
        <Button onClick={() => signIn("google", { callbackUrl })} className="w-full">
          Continue with Google
        </Button>
      )}
      <Button variant="outline" onClick={() => signIn("github", { callbackUrl })} className="w-full">
        Continue with GitHub
      </Button>
    </div>
  );
}

export function AcceptButton({ token }: { token: string }) {
  return (
    <form action={acceptInvite.bind(null, token)}>
      <Button type="submit" className="w-full">
        Accept invitation
      </Button>
    </form>
  );
}
