import { eq } from "drizzle-orm";
import { db } from "@/db";
import { linkedinConnections } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { listLinkedinOrganizations } from "./linkedin-actions";
import { LinkedinApiError } from "@/lib/integrations/linkedin/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LinkedinOrgForm } from "./linkedin-org-form";
import { LinkedinBaseUrlForm } from "./linkedin-base-url-form";
import { LinkedinGuidelinesForm } from "./linkedin-guidelines-form";
import { LinkedinDisconnectButton } from "./linkedin-disconnect-button";

function describeError(error: unknown): string {
  if (error instanceof LinkedinApiError) {
    if (error.status === 401 || error.status === 403) {
      return `LinkedIn rejected the stored token (${error.status}). Reconnect your LinkedIn account below.`;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong talking to LinkedIn.";
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </div>
  );
}

export async function LinkedinForm() {
  const session = await requireSession();
  const [connection] = await db
    .select()
    .from(linkedinConnections)
    .where(eq(linkedinConnections.tenantId, session.user.tenantId))
    .limit(1);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>LinkedIn company page</CardTitle>
        {connection?.status === "needs_reauth" && <Badge variant="destructive">Needs reconnect</Badge>}
      </CardHeader>
      <CardContent className="space-y-4">
        {await renderStep(connection)}
        {connection && connection.status !== "needs_reauth" && (
          <div className="pt-2">
            <LinkedinDisconnectButton />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type Connection = typeof linkedinConnections.$inferSelect;

async function renderStep(connection: Connection | undefined) {
  // Step 1: not connected, or the stored token needs replacing — send to OAuth.
  if (!connection || connection.status === "needs_reauth") {
    return (
      <div className="space-y-3">
        {connection?.status === "needs_reauth" && (
          <ErrorBanner message="LinkedIn disconnected this app. Reconnect to keep publishing." />
        )}
        <p className="text-sm text-muted-foreground">
          Connect LinkedIn to publish product updates to your company page.
        </p>
        <Button variant="outline" render={<a href="/api/linkedin/connect" />}>
          Connect LinkedIn
        </Button>
      </div>
    );
  }

  // Step 2: connected but no company page chosen.
  if (!connection.organizationUrn) {
    try {
      const orgs = await listLinkedinOrganizations();
      return <LinkedinOrgForm orgs={orgs} />;
    } catch (error) {
      return <ErrorBanner message={describeError(error)} />;
    }
  }

  // Step 3: company page chosen but no changelog base URL yet.
  if (!connection.baseUrl) {
    return (
      <div className="space-y-3">
        <p className="text-sm">
          Posting to <strong>{connection.organizationName}</strong>
        </p>
        <LinkedinBaseUrlForm />
      </div>
    );
  }

  // Step 4: fully configured.
  return (
    <div className="space-y-4">
      <div className="space-y-1 text-sm">
        <p>
          Posting to <strong>{connection.organizationName}</strong>
        </p>
        <p className="text-muted-foreground">Link base: {connection.baseUrl}</p>
      </div>
      <LinkedinGuidelinesForm initialGuidelines={connection.postGuidelines ?? ""} />
    </div>
  );
}
