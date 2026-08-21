"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { EngineId } from "@/lib/ai-visibility/types";
import { ENGINE_LABEL, ENGINE_SHORT } from "../../engine-labels";
import { HighlightedAnswer, type AnswerAlias } from "./highlighted-answer";

export type SampleView = {
  id: string;
  engine: EngineId;
  sampleIndex: number;
  askedAtLabel: string;
  modelId: string | null;
  status: "ok" | "error" | "refused" | "pending";
  answerText: string;
  framing: string | null;
  level: "absent" | "mentioned" | "described" | "recommended" | null;
  flagged: boolean;
  error: string | null;
  citations: { url: string; domain: string; domainClass: string }[];
};

const LEVEL_LABEL: Record<NonNullable<SampleView["level"]>, string> = {
  absent: "Not named",
  mentioned: "Mentioned",
  described: "Described",
  recommended: "Recommended",
};

/**
 * One answer, as it came back.
 *
 * Clamped to about twelve lines with an expander rather than truncated: the
 * mention is usually in the first paragraph, but the reason we were or were
 * not recommended is usually not, and a hard truncation would hide exactly
 * the part someone opened this page to read.
 *
 * An errored or refused sample renders its reason instead of an empty body.
 * These rows are excluded from every rate, and showing them as blank answers
 * would make the run look like it produced nothing rather than that one
 * engine declined.
 */
function Sample({ sample, aliases }: { sample: SampleView; aliases: AnswerAlias[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li
      className={cn(
        "space-y-2 rounded-lg border p-3",
        // A D/J disagreement is readable but is NOT a clean measurement —
        // it is excluded from every rate, so it gets the same stale
        // treatment a paused prompt and a stale signal get rather than
        // sitting next to sound rows looking identical.
        sample.flagged && "dashed-outline border-transparent opacity-85"
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Sample {sample.sampleIndex + 1}</span>
        <span>·</span>
        <span>{sample.askedAtLabel}</span>
        {sample.modelId && (
          <>
            <span>·</span>
            <span className="font-mono">{sample.modelId}</span>
          </>
        )}
        {/* "Recommended" vs "mentioned" is what the reader is scanning for;
            the highlight alone cannot say it. */}
        {sample.level && <Badge variant="secondary">{LEVEL_LABEL[sample.level]}</Badge>}
        {sample.flagged && <Badge variant="outline">Excluded — checks disagreed</Badge>}
        {sample.status !== "ok" && (
          <Badge variant="destructive">{sample.status === "refused" ? "Refused" : "Error"}</Badge>
        )}
      </div>

      {sample.status === "ok" ? (
        <>
          <HighlightedAnswer
            text={sample.answerText}
            aliases={aliases}
            className={cn(!expanded && "line-clamp-[12]")}
          />
          <Button variant="ghost" size="sm" onClick={() => setExpanded((prev) => !prev)}>
            {expanded ? "Show less" : "Show full answer"}
          </Button>
        </>
      ) : (
        <p className="text-sm text-destructive">
          {sample.error ?? "No answer — excluded from every rate on this page."}
        </p>
      )}

      {sample.framing && <p className="text-sm text-muted-foreground">{sample.framing}</p>}

      {sample.citations.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {sample.citations.map((citation, index) => (
            <li key={`${citation.url}-${index}`}>
              <Badge variant="outline" className="max-w-56">
                <a
                  href={citation.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate hover:underline"
                  title={citation.url}
                >
                  {index + 1}. {citation.domain}
                </a>
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Section 2 of prompt detail: one tab per engine the tenant runs, each
 * stacking that engine's samples newest first. The initial tab comes from
 * `?engine=` so a click on a matrix cell lands on the engine it was about.
 */
export function EngineTabs({
  engines,
  samples,
  aliases,
  initialEngine,
}: {
  engines: EngineId[];
  samples: SampleView[];
  aliases: AnswerAlias[];
  initialEngine: EngineId;
}) {
  return (
    <Tabs defaultValue={initialEngine}>
      <TabsList>
        {engines.map((engine) => (
          <TabsTrigger key={engine} value={engine} title={ENGINE_LABEL[engine]}>
            {ENGINE_SHORT[engine]}
          </TabsTrigger>
        ))}
      </TabsList>
      {engines.map((engine) => {
        const forEngine = samples.filter((sample) => sample.engine === engine);
        return (
          <TabsContent key={engine} value={engine}>
            {forEngine.length === 0 ? (
              <p className="text-sm text-muted-foreground">No answers from {ENGINE_LABEL[engine]} yet.</p>
            ) : (
              <ul className="space-y-3">
                {forEngine.map((sample) => (
                  <Sample key={sample.id} sample={sample} aliases={aliases} />
                ))}
              </ul>
            )}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}
