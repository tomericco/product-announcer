import { NextRequest, NextResponse } from "next/server";
import { verifyGithubSignature } from "@/lib/integrations/github/github-webhook";
import { ingestMergedPullRequest } from "@/lib/change-items/ingest-pull-request";
import { ingestPush } from "@/lib/change-items/ingest-push";
import { getCommitDiff } from "@/lib/integrations/github/github";

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
      const installationId = String(payload.installation.id);
      await ingestPush(
        {
          installationId,
          repoFullName: payload.repository.full_name,
          ref: payload.ref,
          commits: payload.commits.map((c: { id: string; message: string; url: string; timestamp: string }) => ({
            id: c.id,
            message: c.message,
            url: c.url,
            timestamp: c.timestamp,
          })),
        },
        (owner, repoName, sha) => getCommitDiff(installationId, `${owner}/${repoName}`, sha)
      );
    }
  } catch (error) {
    console.error("Error processing GitHub webhook:", error);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
