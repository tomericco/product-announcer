"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createManualBrief, type ManualBriefInput } from "./actions";

/**
 * The pre-fillable subset of a proposal. Mirrors `ProposalResult`'s `ok`
 * branch in `src/lib/briefs/propose.ts` (`Omit<ProposedBrief,
 * "evidenceSignalIds">`) field-for-field, but is spelled out here rather than
 * imported: `propose.ts` pulls in the AI SDK, the model resolver, and the
 * database, and importing even a type from it into this `"use client"` file
 * risks that changing under a future edit. `page.tsx` (a Server Component)
 * reads the real result and hands down only this plain shape — the same
 * boundary `SignalsList` draws around `MAX_PROPOSAL_SIGNALS`.
 */
type BriefProposal = {
  contentType: "product_update" | "blog_post" | "social_post";
  title: string;
  angle: string;
  whyNow: string;
  audience: string | null;
  keyPoints: string[];
  targetLength: number | null;
  suggestedChannel: string;
  score: number;
  scoreRationale: string;
};

type EvidenceSignal = { id: string; title: string; kind: string };

const CONTENT_TYPE_LABEL: Record<BriefProposal["contentType"], string> = {
  product_update: "Product update",
  blog_post: "Blog post",
  social_post: "Social post",
};

const CONTENT_TYPES = Object.keys(CONTENT_TYPE_LABEL) as BriefProposal["contentType"][];

const SIGNAL_KIND_LABEL: Record<string, string> = {
  shipped_work: "Shipped work",
  competitor_move: "Competitor move",
  market_news: "Market news",
  manual: "Manual",
};

/** A blank starting point for the fields the proposal would otherwise fill. */
const BLANK: BriefProposal = {
  contentType: "blog_post",
  title: "",
  angle: "",
  whyNow: "",
  audience: null,
  keyPoints: [],
  targetLength: null,
  suggestedChannel: "",
  // 0.5 is a neutral placeholder, not a judgement — the design doc is
  // explicit that a manual brief's score "means less here" and is never
  // surfaced back to the human as an assessment of their own idea.
  score: 0.5,
  scoreRationale: "",
};

function keyPointsToText(points: string[]): string {
  return points.join("\n");
}

function textToKeyPoints(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The brief form: always blank, always hand-written. This is the only path
 * that reaches it now — the proposal moved to the modal on `/signals`, which
 * creates the brief outright instead of pre-filling this form, so the
 * `proposal`/`proposalError` props and the "the agent couldn't propose"
 * notice they drove are gone. The page's only caller passed `null` for both.
 *
 * `evidence` — the signals chosen on `/signals` and scoped to this tenant by
 * the page — is fixed, not re-editable here; adding or removing evidence is
 * out of this form's scope (it happens on `/signals` itself, per the design
 * doc). It is attached on save either way, which is what keeps the modal's
 * "Write it by hand" fallback from costing the user their selection.
 *
 * The saved brief never expires: `createManualBrief` defaults `expiresAt` to
 * null, and nothing here overrides it, because a brief someone typed is a
 * decision and not a candidate awaiting one.
 */
export function BriefForm({ evidence }: { evidence: EvidenceSignal[] }) {
  const router = useRouter();
  const initial = BLANK;

  const [contentType, setContentType] = useState<BriefProposal["contentType"]>(initial.contentType);
  const [title, setTitle] = useState(initial.title);
  const [angle, setAngle] = useState(initial.angle);
  const [whyNow, setWhyNow] = useState(initial.whyNow);
  const [audience, setAudience] = useState(initial.audience ?? "");
  const [keyPointsText, setKeyPointsText] = useState(keyPointsToText(initial.keyPoints));
  const [suggestedChannel, setSuggestedChannel] = useState(initial.suggestedChannel);
  const [targetLength, setTargetLength] = useState(initial.targetLength ? String(initial.targetLength) : "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Title is required.");
      return;
    }

    setSubmitting(true);
    setError(null);

    const parsedLength = targetLength.trim() ? Number(targetLength) : null;

    const input: ManualBriefInput = {
      contentType,
      title: trimmedTitle,
      angle: angle.trim(),
      whyNow: whyNow.trim(),
      keyPoints: textToKeyPoints(keyPointsText),
      suggestedChannel: suggestedChannel.trim(),
      targetLength: parsedLength && Number.isFinite(parsedLength) ? Math.trunc(parsedLength) : null,
      audience: audience.trim() || null,
      score: initial.score,
      // Not user-editable — it's the model's own rationale for `score`, which
      // this form never surfaces as a judgement of the human's idea (see the
      // `score` doc comment on `BLANK` above). Passed through so it isn't
      // dropped on save, same as `score` itself.
      scoreRationale: initial.scoreRationale || null,
      signalIds: evidence.map((s) => s.id),
    };

    const result = await createManualBrief(input);
    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    router.push("/board");
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-5">
      {evidence.length > 0 && (
        <div className="space-y-1.5">
          <Label>Evidence</Label>
          <div className="flex flex-wrap gap-2">
            {evidence.map((signal) => (
              <Badge key={signal.id} variant="outline" className="max-w-64">
                <span className="truncate" title={signal.title}>
                  {signal.title}
                </span>
                <span className="text-muted-foreground">· {SIGNAL_KIND_LABEL[signal.kind] ?? signal.kind}</span>
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="brief-content-type">Content type</Label>
        <Select value={contentType} onValueChange={(value) => setContentType(value as BriefProposal["contentType"])}>
          <SelectTrigger id="brief-content-type" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CONTENT_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {CONTENT_TYPE_LABEL[type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="brief-title">Title</Label>
        <Input id="brief-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="brief-angle">Angle</Label>
        <Textarea id="brief-angle" value={angle} onChange={(e) => setAngle(e.target.value)} rows={2} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="brief-why-now">Why now</Label>
        <Textarea id="brief-why-now" value={whyNow} onChange={(e) => setWhyNow(e.target.value)} rows={2} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="brief-key-points">Key points (one per line)</Label>
        <Textarea
          id="brief-key-points"
          value={keyPointsText}
          onChange={(e) => setKeyPointsText(e.target.value)}
          rows={4}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="brief-channel">Suggested channel</Label>
          <Input
            id="brief-channel"
            value={suggestedChannel}
            onChange={(e) => setSuggestedChannel(e.target.value)}
            placeholder="blog, twitter, changelog…"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="brief-target-length">Target length</Label>
          <Input
            id="brief-target-length"
            type="number"
            min={1}
            value={targetLength}
            onChange={(e) => setTargetLength(e.target.value)}
            placeholder="Words"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="brief-audience">Audience (optional)</Label>
        <Input id="brief-audience" value={audience} onChange={(e) => setAudience(e.target.value)} />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.push("/board")} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !title.trim()}>
          {submitting ? "Saving…" : "Save brief"}
        </Button>
      </div>
    </form>
  );
}
