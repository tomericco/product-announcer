import { eq } from "drizzle-orm";
import { db } from "@/db";
import { webflowConnections } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { decryptSecret } from "@/lib/credentials/encryption";
import {
  listSites,
  listCollections,
  getCollection,
  WebflowApiError,
  type WebflowCollectionDetail,
} from "@/lib/integrations/webflow/client";
import { validateMapping } from "@/lib/integrations/webflow/mapping";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WebflowTokenForm } from "./webflow-token-form";
import { WebflowSiteForm } from "./webflow-site-form";
import { WebflowCollectionForm } from "./webflow-collection-form";
import { WebflowMappingForm } from "./webflow-mapping-form";
import { WebflowDisconnectButton } from "./webflow-disconnect-button";
import { WebflowChangeSite } from "./webflow-change-site";
import { WebflowChangeCollection } from "./webflow-change-collection";

// A Webflow outage or an expired token must not blank the whole integrations
// page — the webhook card above lives on the same page and must keep
// rendering regardless of what happens here.
function describeError(error: unknown): string {
  if (error instanceof WebflowApiError) {
    // Kept in sync with webflow.ts's isAuthFailure: both 401 (revoked token)
    // and 403 (app uninstalled / insufficient scope) are reconnect-worthy —
    // Webflow issues no refresh token, so neither can self-heal by retrying.
    if (error.status === 401 || error.status === 403) {
      return `Webflow rejected the stored token (${error.status} ${
        error.status === 401 ? "Unauthorized" : "Forbidden"
      }). Reconnect your Webflow account below.`;
    }
    const details = error.validationDetails.length > 0 ? ` ${error.validationDetails.join(" ")}` : "";
    return `${error.message}${details}`;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong talking to Webflow.";
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </div>
  );
}

function StatusBanner({ status, problems }: { status: string; problems: string[] }) {
  if (status === "needs_reauth") {
    return (
      <ErrorBanner message="Your Webflow connection needs to be reconnected. Paste a fresh Site API token below." />
    );
  }
  if (status === "misconfigured") {
    return (
      <ErrorBanner
        message={problems.length > 0 ? problems.join(" ") : "This Webflow connection is misconfigured."}
      />
    );
  }
  return null;
}

export async function WebflowForm() {
  const session = await requireSession();
  const [connection] = await db
    .select()
    .from(webflowConnections)
    .where(eq(webflowConnections.tenantId, session.user.tenantId))
    .limit(1);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>Webflow CMS</CardTitle>
        {connection && connection.status !== "active" && (
          <Badge variant={connection.status === "needs_reauth" ? "destructive" : "outline"}>
            {connection.status === "needs_reauth" ? "Needs reconnect" : "Misconfigured"}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {await renderStep(connection)}
        {connection && (
          <div className="pt-2">
            <WebflowDisconnectButton />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type Connection = typeof webflowConnections.$inferSelect;

async function renderStep(connection: Connection | undefined) {
  // Step 1: no connection yet, or the stored token needs to be replaced.
  if (!connection) {
    return <WebflowTokenForm />;
  }

  if (connection.status === "needs_reauth") {
    return (
      <>
        <StatusBanner status={connection.status} problems={[]} />
        <WebflowTokenForm />
      </>
    );
  }

  // A corrupted row, a rotated CREDENTIALS_ENCRYPTION_KEY, or a fresh
  // environment missing that key all make this throw by design (see
  // encryption.ts). There is no error boundary above this component, so an
  // unguarded throw here would blank the whole /integrations page —
  // including the webhook card and the Disconnect button that is the user's
  // only way to clear the bad row. Catch it and keep Disconnect reachable.
  let token: string;
  try {
    token = decryptSecret({
      ciphertext: connection.tokenCiphertext,
      iv: connection.tokenIv,
      authTag: connection.tokenAuthTag,
    });
  } catch {
    return (
      <ErrorBanner message="Your Webflow connection can't be read right now (its stored credentials failed to decrypt). Disconnect below, then reconnect with a fresh Site API token." />
    );
  }

  // Step 2: connection but no site chosen yet.
  if (!connection.siteId) {
    try {
      const sites = await listSites(token);
      return <WebflowSiteForm sites={sites} />;
    } catch (error) {
      return <ErrorBanner message={describeError(error)} />;
    }
  }

  // Step 3: site chosen but no collection yet.
  if (!connection.collectionId) {
    // Keyed on siteId: after a successful "Change site" save this component
    // must collapse back to the summary line rather than keep showing the
    // now-stale picker it had fetched, and revalidatePath() re-renders this
    // server component in place without otherwise remounting its children.
    const changeSite = (
      <WebflowChangeSite key={connection.siteId} currentSiteId={connection.siteId} currentSiteName={connection.siteName} />
    );
    try {
      const collections = await listCollections(token, connection.siteId);
      return (
        <>
          {changeSite}
          <WebflowCollectionForm collections={collections} />
        </>
      );
    } catch (error) {
      return (
        <>
          {changeSite}
          <ErrorBanner message={describeError(error)} />
        </>
      );
    }
  }

  // Step 4: collection chosen — render the field mapping form. "Change site"
  // and "Change collection" stay available here too, so picking the wrong
  // collection doesn't force a full disconnect (Webflow only shows a Site
  // API token once, so disconnecting means generating a brand-new one).
  // Same key rationale as step 3, plus collectionId so "Change collection"
  // also collapses back to its summary line after a successful save.
  const changeSite = (
    <WebflowChangeSite key={connection.siteId} currentSiteId={connection.siteId} currentSiteName={connection.siteName} />
  );
  const changeCollection = (
    <WebflowChangeCollection
      key={connection.collectionId}
      currentCollectionId={connection.collectionId}
      currentCollectionName={connection.collectionName}
    />
  );

  let collection: WebflowCollectionDetail;
  try {
    collection = await getCollection(token, connection.collectionId);
  } catch (error) {
    return (
      <>
        {changeSite}
        {changeCollection}
        <ErrorBanner message={describeError(error)} />
      </>
    );
  }

  const problems =
    connection.status === "misconfigured" ? validateMapping(connection.fieldMapping, collection.fields) : [];

  return (
    <>
      <StatusBanner status={connection.status} problems={problems} />
      {changeSite}
      {changeCollection}
      <WebflowMappingForm
        collection={collection}
        mapping={connection.fieldMapping}
        publishMode={connection.publishMode}
      />
    </>
  );
}
