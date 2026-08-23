import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { db } from "@/db";
import { tenants } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { listCompetitors } from "@/lib/workspace/competitors";
import { buildAliases } from "@/lib/ai-visibility/aliases";
import { citedDomains } from "@/lib/ai-visibility/cited-domains";
import { MIN_N_PROMPT, promptHistory, promptSamples } from "@/lib/ai-visibility/metrics";
import { getPrompt } from "@/lib/ai-visibility/prompts";
import { getAiVisibilitySettings } from "@/lib/ai-visibility/settings";
import type { PromptIntent } from "@/lib/ai-visibility/types";
import { relatedPieces } from "@/lib/briefs/query";
import { DATE_FORMAT } from "../../../company/source-status";
import { CitedDomainsTable } from "../../cited-domains-table";
import { engineGridClass } from "../../engine-grid";
import { ENGINE_LABEL, ENGINE_ORDER } from "../../engine-labels";
import { RateSparkline } from "../../rate-sparkline";
// Not from "../../rate-sparkline": this is a Server Component, and a function
// imported through a "use client" module is a client reference it cannot call.
import { publishMarkerRunIds, type RatePoint } from "../../sparkline-points";
import { INTENT_LABEL } from "../prompts-editor";
import { EngineTabs, type SampleView } from "./engine-tabs";
import type { AnswerAlias } from "./highlighted-answer";

/**
 * One prompt, four sections: how each engine has answered it over twelve runs,
 * the raw answers, the domains cited on this question, and the pieces whose
 * brief cited a signal from it.
 *
 * `params` and `searchParams` are both Promises in Next 16. `getPrompt`
 * returns null for a prompt that does not exist AND for another tenant's —
 * deliberately undistinguished — and both become `notFound()`.
 *
 * No test: an async Server Component whose derivations live in tested modules
 * (`HighlightedAnswer`, `publishMarkerRunIds`, `relatedPieces`).
 */
export default async function PromptDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ promptId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { promptId } = await params;
  const query = await searchParams;
  const session = await requireSession();
  const tenantId = session.user.tenantId;

  const prompt = await getPrompt(tenantId, promptId);
  if (!prompt) notFound();

  const [settings, tenantRows, competitors, samples, sources, pieces] = await Promise.all([
    getAiVisibilitySettings(tenantId),
    // The tenant's NAME — the brand the extractor matched. The company
    // profile is deliberately not loaded here: its `category` is the market
    // ("Issue tracking software"), not the brand, and highlighting it as
    // "you" was the exact bug this page must not have.
    db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)),
    listCompetitors(tenantId),
    // No `engine` filter: the limit then applies PER ENGINE, so every tab
    // gets a full set instead of twelve rows that all happen to be OpenAI.
    promptSamples(tenantId, promptId, { limit: 12 }),
    citedDomains(tenantId, { promptId, runs: 12 }),
    relatedPieces(tenantId, promptId),
  ]);
  const tenantName = tenantRows[0]?.name ?? "";

  const engines = ENGINE_ORDER.filter((engine) => settings.engines.includes(engine));
  const requestedEngine = Array.isArray(query.engine) ? query.engine[0] : query.engine;
  const initialEngine = engines.find((engine) => engine === requestedEngine) ?? engines[0] ?? ENGINE_ORDER[0];

  // Per-engine history, one call each — the same read the overview tile
  // makes, narrowed to this prompt.
  const histories = await Promise.all(engines.map((engine) => promptHistory(tenantId, promptId, engine)));

  // Publish markers, from the pieces this prompt's signals fed. No causal
  // copy anywhere near them: at this n, attribution is unknowable, and the
  // design says so explicitly.
  const publishedAts = pieces
    .filter((piece) => piece.publishedAt !== null)
    .map((piece) => piece.publishedAt!);

  // Aliases are built SERVER-side and cross as plain data. `buildAliases(name)`
  // takes ONE brand name and returns its spellings — the tenant's come from
  // the tenant's NAME (the same input the extractor uses), each competitor's
  // from its own name. Flattened so `HighlightedAnswer` can label every
  // spelling with the brand it belongs to.
  const aliases: AnswerAlias[] = [
    ...buildAliases(tenantName).map((name) => ({ name, kind: "tenant" as const, label: tenantName })),
    ...competitors.flatMap((competitor) =>
      buildAliases(competitor.name).map((name) => ({
        name,
        kind: "competitor" as const,
        label: competitor.name,
      }))
    ),
  ];

  const sampleViews: SampleView[] = samples.map((sample) => ({
    id: sample.id,
    engine: sample.engine,
    sampleIndex: sample.sampleIndex,
    // A pinned UTC formatter: an unpinned `toLocaleString()` renders
    // differently on server and client and breaks hydration.
    askedAtLabel: sample.askedAt ? DATE_FORMAT.format(sample.askedAt) : "Not asked yet",
    modelId: sample.modelId,
    status: sample.status as SampleView["status"],
    answerText: sample.answerText ?? "",
    framing: sample.framing,
    level: sample.level,
    flagged: sample.flagged,
    error: sample.error,
    citations: sample.citations.map((citation) => ({
      url: citation.url,
      domain: citation.domain,
      domainClass: citation.domainClass,
    })),
  }));

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link href="/ai-visibility/prompts" className="text-sm text-muted-foreground hover:underline">
          ← Prompts
        </Link>
        {/* The only font-heading on this page: the question itself is the title. */}
        <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">{prompt.text}</h1>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{INTENT_LABEL[prompt.intent as PromptIntent]}</Badge>
          {prompt.persona && <Badge variant="outline">{prompt.persona}</Badge>}
          {prompt.branded && <Badge variant="outline">Brand check</Badge>}
          {prompt.status === "paused" && <Badge variant="outline">Paused</Badge>}
        </div>
        {prompt.flagReason && <p className="text-sm text-destructive">{prompt.flagReason}</p>}
        {/* Both directions of the supersede chain, so history is reachable
            from whichever wording you arrived at. */}
        {prompt.supersedesId && (
          <p className="text-sm text-muted-foreground">
            Replaces{" "}
            <Link href={`/ai-visibility/prompts/${prompt.supersedesId}`} className="underline underline-offset-2">
              an earlier wording
            </Link>
            .
          </p>
        )}
        {prompt.supersededById && (
          <p className="text-sm text-muted-foreground">
            Replaced by{" "}
            <Link
              href={`/ai-visibility/prompts/${prompt.supersededById}`}
              className="underline underline-offset-2"
            >
              a newer wording
            </Link>
            .
          </p>
        )}
      </div>

      {/* Section 1 — per-engine cards, one per ENABLED engine: 1 to 3 of them,
          not the four columns this row used to reserve. */}
      <div className={engineGridClass(engines.length)}>
        {engines.map((engine, index) => {
          const history = histories[index];
          const named = history.filter((point) => point.n >= MIN_N_PROMPT && point.hits > 0).length;
          const usable = history.filter((point) => point.n >= MIN_N_PROMPT).length;
          // Each engine's history is its own run list, so the publish→run
          // match is computed per engine, over ITS runs (oldest first).
          const publishRuns = publishMarkerRunIds(history, publishedAts);
          const points: RatePoint[] = history.map((point, pointIndex) => ({
            runId: point.runId,
            label: DATE_FORMAT.format(new Date(point.runDate)),
            rate: point.n >= MIN_N_PROMPT ? (point.hits / point.n) * 100 : null,
            modelChange:
              pointIndex > 0 && point.modelId && point.modelId !== history[pointIndex - 1].modelId
                ? point.modelId
                : null,
            publishedLabel: publishRuns.has(point.runId) ? "published" : null,
          }));

          return (
            <Card key={engine} size="sm">
              <CardHeader>
                <CardTitle className="truncate" title={ENGINE_LABEL[engine]}>
                  {ENGINE_LABEL[engine]}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-sm">
                  {usable === 0 ? "No usable runs yet" : `Named in ${named} of last ${usable} runs`}
                </p>
                <RateSparkline
                  points={points}
                  ariaLabel={`How often ${ENGINE_LABEL[engine]} named you on this prompt, last ${usable} runs`}
                />
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Section 2 — the raw answers. */}
      <Card>
        <CardHeader>
          <CardTitle>Answers</CardTitle>
          <CardDescription>
            What each engine actually said. You are highlighted; tracked competitors are outlined.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EngineTabs engines={engines} samples={sampleViews} aliases={aliases} initialEngine={initialEngine} />
        </CardContent>
      </Card>

      {/* Section 3 — where the answers to THIS question came from. */}
      <Card>
        <CardHeader>
          <CardTitle>Cited sources</CardTitle>
          {/* "of answers to this prompt", not "of answers": the denominator
              here is this prompt's eligible answers, and a reader comparing
              17% here against 17% on the overview would be comparing two
              different fractions. */}
          <CardDescription>
            Domains cited on this prompt over the last 12 runs, as a share of answers to this prompt.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">No citations recorded for this prompt yet.</p>
          ) : (
            <CitedDomainsTable
              rows={sources.map((row) => ({
                domain: row.domain,
                citations: row.citations,
                answerSharePct: row.answerShare,
                engines: row.engines,
                domainClass: row.domainClass,
                // Per-prompt, while `new_cited_domain` signals are per-domain:
                // there is no signal id to link, and passing null is what makes
                // the action absent rather than broken. Do not synthesize one.
                signalId: null,
                // And nothing was looked up, so the cell must not explain the
                // absence either: this table never asked the signals table a
                // question, so it cannot say whether one expired or never
                // fired. Silence is the only honest reading here.
                everSignalled: null,
              }))}
            />
          )}
        </CardContent>
      </Card>

      {/* Section 4 — related pieces. No causal copy: a list and a date. */}
      {pieces.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Related pieces</CardTitle>
            <CardDescription>
              Content whose brief cited a signal from this prompt. Published dates are marked on the sparklines
              above.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-sm">
              {pieces.map((piece) => (
                <li key={piece.pieceId} className="flex items-center justify-between gap-3">
                  <Link href={`/drafts/${piece.pieceId}`} className="truncate hover:underline">
                    {piece.title}
                  </Link>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {piece.publishedAt ? DATE_FORMAT.format(piece.publishedAt) : piece.status}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
