import { NextRequest, NextResponse } from "next/server";
import { verifyGithubSignature } from "@/lib/github-webhook";
import { ingestMergedPullRequest } from "@/lib/ingest-pull-request";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!(await verifyGithubSignature(rawBody, signature))) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  const payload = JSON.parse(rawBody);

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

  return NextResponse.json({ ok: true });
}
