"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { generateInviteLink, revokeInviteLink } from "./actions";
import type { WorkspaceMember } from "@/lib/workspace/members";

export function MembersSection({
  members,
  isOwner,
  hasActiveInvite,
}: {
  members: WorkspaceMember[];
  isOwner: boolean;
  hasActiveInvite: boolean;
}) {
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [active, setActive] = useState(hasActiveInvite);
  const [busy, setBusy] = useState(false);

  async function onGenerate() {
    setBusy(true);
    try {
      const { url } = await generateInviteLink();
      setInviteUrl(url);
      setActive(true);
      await navigator.clipboard.writeText(url).catch(() => {});
      toast.success("Invite link generated and copied");
    } catch {
      toast.error("Could not generate an invite link");
    } finally {
      setBusy(false);
    }
  }

  async function onCopy() {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    toast.success("Invite link copied");
  }

  async function onRevoke() {
    setBusy(true);
    try {
      await revokeInviteLink();
      setInviteUrl(null);
      setActive(false);
      toast.success("Invite link revoked");
    } catch {
      toast.error("Could not revoke the invite link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <ul className="divide-y">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center justify-between py-2">
              <span className="text-sm">{m.name ?? m.email}</span>
              <span className="text-xs text-muted-foreground capitalize">{m.role}</span>
            </li>
          ))}
        </ul>

        {isOwner && (
          <div className="space-y-3 border-t pt-4">
            <p className="text-sm font-medium">Invite link</p>
            <p className="text-xs text-muted-foreground">
              Generating a new link replaces any previous one. Anyone with the current link can join this workspace until it
              expires or is revoked.
            </p>
            {inviteUrl && (
              <div className="flex gap-2">
                <Input readOnly value={inviteUrl} className="flex-1" />
                <Button variant="outline" onClick={onCopy} disabled={busy}>
                  Copy
                </Button>
              </div>
            )}
            <div className="flex gap-2">
              <Button onClick={onGenerate} disabled={busy}>
                {active ? "Regenerate link" : "Generate link"}
              </Button>
              {active && (
                <Button variant="outline" onClick={onRevoke} disabled={busy}>
                  Revoke
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
