import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/workspace/auth";
import { validateInvite } from "@/lib/workspace/invites";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SignInToAccept, AcceptButton } from "./invite-buttons";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const validation = await validateInvite(token);
  const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

  const errorCopy: Record<string, string> = {
    invalid: "This invite link is invalid.",
    expired: "This invite link has expired. Ask a workspace owner for a new one.",
    revoked: "This invite link has been revoked. Ask a workspace owner for a new one.",
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        {validation.status === "valid" ? (
          <ValidInvite token={token} tenantName={validation.tenantName} googleEnabled={googleEnabled} />
        ) : (
          <>
            <CardHeader>
              <CardTitle>Invitation unavailable</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{errorCopy[validation.status]}</p>
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}

async function ValidInvite({ token, tenantName, googleEnabled }: { token: string; tenantName: string; googleEnabled: boolean }) {
  const session = await getServerSession(authOptions);
  return (
    <>
      <CardHeader>
        <CardTitle>Join {tenantName}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          You&apos;ve been invited to join the <strong>{tenantName}</strong> workspace.
        </p>
        {session?.user?.id ? <AcceptButton token={token} /> : <SignInToAccept token={token} googleEnabled={googleEnabled} />}
      </CardContent>
    </>
  );
}
