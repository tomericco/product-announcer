"use client";

import { signOut } from "next-auth/react";
import { LogOut } from "lucide-react";
import { initials } from "@/lib/workspace/initials";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Sidebar footer identity + account menu. The avatar is initials-only (no
 * remote image fetch — keeps the app free of external image requests). The
 * single action is Log out, via NextAuth's `signOut`, which POSTs to the
 * unguarded /api/auth/signout and redirects to sign-in. No SessionProvider is
 * required for `signOut`.
 */
export function UserMenu({ email, name }: { email: string; name: string | null }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" className="h-auto w-full justify-start gap-2 px-2 py-1.5 font-normal" />
        }
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[0.625rem] font-medium text-muted-foreground">
          {initials(name || email)}
        </span>
        <span className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground">{email}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[13rem]">
        <DropdownMenuItem onClick={() => signOut({ callbackUrl: "/api/auth/signin" })}>
          <LogOut />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
