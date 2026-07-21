import { NextRequest, NextResponse, after } from "next/server";
import { verifyGithubSignature, parsePushedAt } from "@/lib/integrations/github/github-webhook";
import { ingestMergedPullRequest } from "@/lib/change-events/ingest-pull-request";
import { ingestPush } from "@/lib/change-events/ingest-push";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!(await verifyGithubSignature(rawBody, signature))) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  const payload = JSON.parse(rawBody);

  const isProcessableEvent =
    (event === "pull_request" && payload.action === "closed" && payload.pull_request?.merged) || event === "push";

  if (isProcessableEvent && !payload.installation?.id) {
    return NextResponse.json({ ok: true, skipped: "no installation" });
  }

  try {
    if (event === "pull_request" && payload.action === "closed" && payload.pull_request?.merged) {
      await ingestMergedPullRequest({
        installationId: String(payload.installation.id),
        repoFullName: payload.repository.full_name,
        baseBranch: payload.pull_request.base.ref,
        prNumber: payload.pull_request.number,
        prTitle: payload.pull_request.title,
        prDescription: payload.pull_request.body ?? "",
        prUrl: payload.pull_request.html_url,
        mergedAt: new Date(payload.pull_request.merged_at),
      });
    }

    if (event === "push") {
      const pushInput = {
        installationId: String(payload.installation.id),
        repoFullName: payload.repository.full_name,
        ref: payload.ref,
        before: payload.before,
        after: payload.after,
        // When the push landed. Captured here rather than in the deferred
        // ingest, which runs after the enrichment round-trip and would read
        // minutes late. Falls back to receipt time if GitHub omits the field.
        pushedAt: parsePushedAt(payload.repository?.pushed_at) ?? new Date(),
        payloadCommits: payload.commits.map((c: { id: string; message: string; url: string; timestamp: string }) => ({
          id: c.id,
          message: c.message,
          url: c.url,
          timestamp: c.timestamp,
        })),
      };
      after(async () => {
        try {
          await ingestPush(pushInput);
        } catch (error) {
          console.error("Deferred push ingestion failed:", error);
        }
      });
    }
  } catch (error) {
    console.error("Error processing GitHub webhook:", error);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
