"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { EngineId } from "@/lib/ai-visibility/types";
// Dependency-free module — safe on this side of the client boundary, and the
// same two numbers `saveAiVisibilitySettings` validates against.
import { MIN_MONTHLY_CAP_USD, MAX_MONTHLY_CAP_USD } from "@/lib/ai-visibility/money";
// Also dependency-free, and the same brand-check rule `capExceeded` charges and
// the two Run-now buttons quote. This card had its own copy of it.
import { callsPerEnginePerRun } from "@/lib/ai-visibility/planned-calls";
import { saveAiVisibilityConfig } from "./actions";

const CADENCE_OPTIONS = [
  { value: "weekly", label: "Weekly" },
  { value: "fortnightly", label: "Every two weeks" },
  { value: "off", label: "Off" },
];

const DAY_OPTIONS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
].map((label, value) => ({ value: String(value), label }));

const SAMPLE_OPTIONS = [
  { value: "1", label: "1 sample" },
  { value: "3", label: "3 samples" },
  { value: "5", label: "5 samples" },
];

/** Weekly runs per month, averaged: 52 weeks / 12 months. */
const RUNS_PER_MONTH: Record<string, number> = { weekly: 52 / 12, fortnightly: 52 / 24, off: 0 };

function labelFor(options: { value: string; label: string }[], value: string) {
  return options.find((option) => option.value === value)?.label ?? value;
}

/**
 * "≈ $X/month at current settings" — plain dollars, never credits, because
 * unpredictability is the specific thing people dislike about credit
 * systems. An engine with a free tier (Gemini's 5k grounded prompts a month)
 * comes through as a `costPerCall` of 0, so turning it on visibly costs
 * nothing rather than being silently excluded.
 */
export function monthlyEstimateUsd({
  promptCount,
  brandCheckCount = 0,
  engines,
  samplesPerPrompt,
  cadence,
  costPerCall,
}: {
  promptCount: number;
  /**
   * How many of `promptCount` are `brand_check` prompts. They are sampled
   * exactly once regardless of the samples setting, which is what
   * `capExceeded` charges — a trust cue that disagrees with the gate it is
   * describing is worse than no number.
   */
  brandCheckCount?: number;
  engines: EngineId[];
  samplesPerPrompt: number;
  cadence: "weekly" | "fortnightly" | "off";
  costPerCall: Record<EngineId, number>;
}): number {
  const runs = RUNS_PER_MONTH[cadence] ?? 0;
  return engines.reduce(
    (total, engine) =>
      total +
      callsPerEnginePerRun(promptCount, brandCheckCount, samplesPerPrompt) * runs * (costPerCall[engine] ?? 0),
    0
  );
}

/**
 * Cadence, engines, samples and the monthly cap. Follows `ScheduleForm`:
 * local state per control, a plain `<form action={…}>` posting `FormData`,
 * one Save.
 *
 * `enabled` is deliberately absent — that switch lives on the Company card,
 * and a Settings save must never be able to turn the feature back on.
 *
 * The per-call costs arrive as a plain record from the page rather than being
 * read here: `engineCost` lives in `@/lib/ai-visibility/engines`, which is the
 * three fetch-based API clients, and importing a runtime value from it into a
 * client file would pull all three into the browser bundle.
 */
export function AiVisibilityForm({
  defaults,
  engines,
  promptCount,
  brandCheckCount = 0,
  costPerCall,
  spentUsd,
}: {
  defaults: {
    cadence: "weekly" | "fortnightly" | "off";
    dayOfWeek: number;
    samplesPerPrompt: number;
    monthlyCapUsd: number;
  };
  /**
   * The engines that will actually run — `settings.engines` intersected with
   * the engines holding an enabled, verified key.
   *
   * Read-only here. This form prices what will happen; the AI-engines card
   * above decides what that is.
   */
  engines: EngineId[];
  promptCount: number;
  /** Of `promptCount`, how many are sampled once regardless of the setting. */
  brandCheckCount?: number;
  costPerCall: Record<EngineId, number>;
  spentUsd: number;
}) {
  const [cadence, setCadence] = useState(defaults.cadence);
  const [dayOfWeek, setDayOfWeek] = useState(String(defaults.dayOfWeek));
  const [samples, setSamples] = useState(String(defaults.samplesPerPrompt));
  const [cap, setCap] = useState(String(defaults.monthlyCapUsd));

  const capUsd = Number(cap);
  // The EFFECTIVE engines — the ones with an enabled, verified key — not
  // everything the settings row names. A tenant with three engines on and one
  // Gemini key is quoted Gemini's price, because Gemini is what will run.
  const estimate = monthlyEstimateUsd({
    promptCount,
    brandCheckCount,
    engines,
    samplesPerPrompt: Number(samples),
    cadence,
    costPerCall,
  });
  // Zero effective engines is no longer a reason to block Save. It is an
  // ordinary, fully-explained BYOK state — no keys connected yet — and it is
  // fixed in the card above, not by editing a cadence. The old guard existed
  // because an empty engines list was invalid input to a form that owned the
  // switches; this form no longer owns them.
  const capIsANumber = cap.trim().length > 0 && Number.isFinite(capUsd);
  const overCap = capIsANumber && capUsd > 0 && estimate > capUsd;
  // The same bounds `saveAiVisibilitySettings` enforces. Without the upper one
  // a cap of $600 sailed past Save and came back as an unhandled throw from
  // the action — a blank error page with no hint that the number was at fault.
  const badCap =
    !capIsANumber || capUsd < MIN_MONTHLY_CAP_USD || capUsd > MAX_MONTHLY_CAP_USD;

  async function handleSave(formData: FormData) {
    await saveAiVisibilityConfig(formData);
    toast.success("AI visibility settings saved");
  }

  return (
    <form action={handleSave} className="space-y-5">
      <div className="space-y-2">
        <Label>Run</Label>
        <div className="flex flex-wrap gap-2">
          <Select
            name="cadence"
            value={cadence}
            onValueChange={(value) => setCadence(value as typeof cadence)}
          >
            <SelectTrigger className="w-44" aria-label="Cadence">
              <SelectValue>{labelFor(CADENCE_OPTIONS, cadence)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {CADENCE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {cadence !== "off" && (
            <Select
              name="dayOfWeek"
              value={dayOfWeek}
              onValueChange={(value) => setDayOfWeek(value as string)}
            >
              <SelectTrigger className="w-40" aria-label="Day of week">
                <SelectValue>{labelFor(DAY_OPTIONS, dayOfWeek)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {DAY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        {/* The day still posts while the cadence is "off": the Select above is
            unmounted, so without this the saved day would silently reset to
            Sunday the next time someone turned the schedule back on. */}
        {cadence === "off" && <input type="hidden" name="dayOfWeek" value={dayOfWeek} />}
        <p className="text-xs text-muted-foreground">
          Times are UTC. No daily option — content changes show in 60–90 days, so a daily run would only
          buy noise.
        </p>
      </div>

      {/* The Engines fieldset used to sit here. It moved into the AI-engines
          card above, beside the key each engine depends on: "is ChatGPT part of
          my measurement?" and "do we have a working ChatGPT key?" are the same
          question, and two controls for one decision is a contradiction waiting
          to be rendered. There is now exactly one place to enable an engine.

          This form no longer posts `engines` at all — `saveAiVisibilitySettings`
          treats an absent list as "leave it alone", so saving a cadence here
          cannot undo a switch flipped up there. */}

      <div className="space-y-2">
        <Label>Samples per prompt</Label>
        <Select
          name="samplesPerPrompt"
          value={samples}
          onValueChange={(value) => setSamples(value as string)}
        >
          <SelectTrigger className="w-44" aria-label="Samples per prompt">
            <SelectValue>{labelFor(SAMPLE_OPTIONS, samples)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {SAMPLE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          3 recommended — single samples are noisy. The same question asked twice does not always get the
          same answer, so one sample cannot tell a real change from a coin flip.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="ai-visibility-cap">Monthly engine budget</Label>
        <Input
          id="ai-visibility-cap"
          name="monthlyCapUsd"
          type="number"
          min={MIN_MONTHLY_CAP_USD}
          max={MAX_MONTHLY_CAP_USD}
          step={1}
          className="w-32"
          value={cap}
          onChange={(event) => setCap(event.target.value)}
        />
        <p className="text-xs text-muted-foreground tabular-nums">
          Spent this month ${spentUsd.toFixed(2)} of ${capIsANumber ? capUsd.toFixed(2) : "—"}
        </p>
        {/* The cap did not stop being useful under BYOK; it stopped being ours.
            "We stop spending your money" is MORE valuable than "we stop
            spending ours" — no provider gives you a per-project stop-loss — but
            it is also an estimate against an invoice we cannot see, and saying
            so is the difference between a budget and a promise.

            The second sentence is the one copy must not get wrong: BYOK moves
            the ENGINE share of the cost and nothing else. The judge and prompt
            generation still run on our Anthropic key. */}
        <p className="text-xs text-muted-foreground">
          We stop running when estimated engine spend reaches this. The engines bill your own keys
          directly — these are our estimates, and your provider&apos;s invoice is the record.
        </p>
        <p className="text-xs text-muted-foreground">
          Reading and scoring the answers runs on Versional&apos;s own AI and is included in your plan.
          Only the engine calls hit your keys.
        </p>
        <p className="text-xs text-muted-foreground" data-testid="ai-visibility-estimate">
          ≈ ${estimate.toFixed(2)}/month at current settings
        </p>
        {overCap && (
          <p className="text-xs text-destructive">
            That estimate is above your ${capUsd.toFixed(2)} budget, so runs will pause part-way through the
            month. Drop to 1 sample on the most expensive engine before dropping prompts.
          </p>
        )}
        {badCap && (
          <p className="text-xs text-destructive">
            Set a budget between ${MIN_MONTHLY_CAP_USD} and ${MAX_MONTHLY_CAP_USD} — the feature will
            not run without one, and will not accept a larger one.
          </p>
        )}
      </div>

      <Button type="submit" variant="outline" disabled={badCap}>
        Save
      </Button>
    </form>
  );
}
