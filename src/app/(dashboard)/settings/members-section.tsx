"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MoreHorizontal } from "lucide-react";
import { generateInviteLink, removeMember, revokeInviteLink } from "./actions";
import type { WorkspaceMember } from "@/lib/workspace/members";

// The raw invite token is never stored server-side (invites are hash-only), so
// the server can't re-serve a generated link after a refresh. We keep the last
// generated URL in localStorage, per workspace, and read it through
// useSyncExternalStore so the value survives refreshes without an
// SSR/hydration mismatch. A custom event notifies same-tab subscribers, since
// the native "storage" event only fires in *other* tabs.
const INVITE_LINK_EVENT = "workspace-invite-link:change";

// Format the joined-at date deterministically (pinned locale + UTC) so the
// server-rendered HTML and the client match exactly — an unpinned
// toLocaleString() differs by environment locale/timezone and breaks hydration.
const JOINED_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const JOINED_DATETIME = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function writeStoredInviteLink(storageKey: string, url: string | null) {
  if (url === null) window.localStorage.removeItem(storageKey);
  else window.localStorage.setItem(storageKey, url);
  window.dispatchEvent(new Event(INVITE_LINK_EVENT));
}

function useStoredInviteLink(storageKey: string): string | null {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("storage", onChange);
      window.addEventListener(INVITE_LINK_EVENT, onChange);
      return () => {
        window.removeEventListener("storage", onChange);
        window.removeEventListener(INVITE_LINK_EVENT, onChange);
      };
    },
    () => window.localStorage.getItem(storageKey),
    () => null, // server snapshot: nothing is persisted during SSR
  );
}

export function MembersSection({
  members,
  isOwner,
  hasActiveInvite,
  workspaceId,
  currentUserId,
}: {
  members: WorkspaceMember[];
  isOwner: boolean;
  hasActiveInvite: boolean;
  workspaceId: string;
  currentUserId: string;
}) {
  const router = useRouter();
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [memberToRemove, setMemberToRemove] = useState<WorkspaceMember | null>(null);
  const storageKey = `workspace-invite-link:${workspaceId}`;
  const storedUrl = useStoredInviteLink(storageKey);
  // `active` starts from the server's view and flips on generate/revoke, so a
  // freshly generated link shows immediately even though the `hasActiveInvite`
  // prop stays stale until the next server render.
  const [active, setActive] = useState(hasActiveInvite);
  const [busy, setBusy] = useState(false);
  const inviteUrl = active ? storedUrl : null;

  // If the server reports no active invite on load (revoked / expired / none),
  // drop any stale persisted link so a dead URL can't resurface. This updates
  // the external store, not React state.
  useEffect(() => {
    if (!hasActiveInvite) writeStoredInviteLink(storageKey, null);
  }, [hasActiveInvite, storageKey]);

  async function onGenerate() {
    setBusy(true);
    try {
      const { url } = await generateInviteLink();
      writeStoredInviteLink(storageKey, url);
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
      writeStoredInviteLink(storageKey, null);
      setActive(false);
      toast.success("Invite link revoked");
    } catch {
      toast.error("Could not revoke the invite link");
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove() {
    if (!memberToRemove) return;
    const member = memberToRemove;
    const label = member.name ?? member.email;
    setRemovingId(member.userId);
    try {
      await removeMember(member.userId);
      toast.success(`Removed ${label}`);
      setMemberToRemove(null);
      router.refresh();
    } catch {
      toast.error("Could not remove this member");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="w-10 text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => {
              const joinedAt = new Date(m.createdAt);
              const isSelf = m.userId === currentUserId;
              return (
                <TableRow key={m.userId}>
                  <TableCell>
                    {m.name ?? "—"}
                    {isSelf && <span className="ml-2 text-xs text-muted-foreground">(You)</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{m.email}</TableCell>
                  <TableCell className="capitalize">{m.role}</TableCell>
                  <TableCell className="text-muted-foreground" title={`${JOINED_DATETIME.format(joinedAt)} UTC`}>
                    {JOINED_DATE.format(joinedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="ml-auto"
                            aria-label={`Options for ${m.name ?? m.email}`}
                          />
                        }
                      >
                        <MoreHorizontal />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={!isOwner || isSelf}
                          onClick={() => setMemberToRemove(m)}
                        >
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

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

        <Dialog
          open={memberToRemove !== null}
          onOpenChange={(open) => {
            if (!open) setMemberToRemove(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove teammate</DialogTitle>
              <DialogDescription>
                Remove this member from the workspace? You can re-invite them later with an invite link.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button variant="destructive" onClick={confirmRemove} disabled={removingId !== null}>
                {removingId !== null ? "Removing…" : "Remove"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
