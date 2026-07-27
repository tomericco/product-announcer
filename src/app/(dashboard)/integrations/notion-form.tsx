import { eq } from "drizzle-orm";
import { db } from "@/db";
import { notionConnections, type NotionConnection } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { withFreshToken } from "@/lib/integrations/notion/connection";
import { listDatabases, getDatabaseProperties, NotionApiError } from "@/lib/integrations/notion/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NotionDatabaseForm } from "./notion-database-form";
import { NotionCompletionForm } from "./notion-completion-form";
import { NotionDisconnectButton } from "./notion-disconnect-button";

function describeError(error: unknown): string {
  if (error instanceof NotionApiError) {
    if (error.status === 401 || error.status === 403) {
      return `Notion rejected the stored token (${error.status}). Reconnect your Notion account below.`;
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong talking to Notion.";
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </div>
  );
}

export async function NotionForm({ connectError }: { connectError?: string | null }) {
  const session = await requireSession();
  const [connection] = await db
    .select()
    .from(notionConnections)
    .where(eq(notionConnections.tenantId, session.user.tenantId))
    .limit(1);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>Notion</CardTitle>
        {connection && connection.status !== "active" && (
          <Badge variant={connection.status === "needs_reauth" ? "destructive" : "outline"}>
            {connection.status === "needs_reauth" ? "Needs reconnect" : "Setup incomplete"}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {connectError && <ErrorBanner message={connectError} />}
        {await renderStep(connection)}
        {connection && (
          <div className="pt-2">
            <NotionDisconnectButton />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

async function renderStep(connection: NotionConnection | undefined) {
  // Step 1: not connected, or the token needs replacing — send to OAuth.
  if (!connection || connection.status === "needs_reauth") {
    return (
      <div className="space-y-3">
        {connection?.status === "needs_reauth" && (
          <ErrorBanner message="Your Notion connection needs to be reconnected." />
        )}
        <p className="text-sm text-muted-foreground">
          Connect Notion to turn completed tasks into product updates.
        </p>
        <Button variant="outline" render={<a href="/api/notion/connect" />}>
          Connect
        </Button>
      </div>
    );
  }

  // Step 2: connected but no database chosen.
  if (!connection.databaseId) {
    try {
      const databases = await withFreshToken(db, connection, (token) => listDatabases(token));
      return <NotionDatabaseForm databases={databases} />;
    } catch (error) {
      return <ErrorBanner message={describeError(error)} />;
    }
  }

  // Step 3: database chosen — map completion.
  try {
    const properties = await withFreshToken(db, connection, (token) =>
      getDatabaseProperties(token, connection.databaseId!)
    );
    return (
      <NotionCompletionForm
        properties={properties}
        currentStatusPropertyId={connection.statusPropertyId}
        currentDoneValues={connection.doneValues}
      />
    );
  } catch (error) {
    return <ErrorBanner message={describeError(error)} />;
  }
}
