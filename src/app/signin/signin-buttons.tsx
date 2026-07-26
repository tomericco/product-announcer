"use client";

import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";

export function SignInButtons({ callbackUrl, googleEnabled }: { callbackUrl: string; googleEnabled: boolean }) {
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
