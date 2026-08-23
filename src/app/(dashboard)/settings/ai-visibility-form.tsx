"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { ENGINE_LABEL, ENGINE_ORDER } from "../ai-visibility/engine-labels";
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
    (total, engine) => total + callsPerRun(promptCount, brandCheckCount, samplesPerPrompt) * runs * (costPerCall[engine] ?? 0),
    0
  );
}

/**
 * Calls one engine makes in one run. Mirrors `capExceeded`, which counts
 * brand-check prompts at one sample and everything else at the samples
 * setting.
 */
function callsPerRun(promptCount: number, brandCheckCount: number, samplesPerPrompt: number): number {
  const branded = Math.min(Math.max(brandCheckCount, 0), promptCount);
  return (promptCount - branded) * samplesPerPrompt + branded;
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
  promptCount,
  brandCheckCount = 0,
  costPerCall,
  spentUsd,
}: {
  defaults: {
    cadence: "weekly" | "fortnightly" | "off";
    dayOfWeek: number;
    engines: EngineId[];
    samplesPerPrompt: number;
    monthlyCapUsd: number;
  };
  promptCount: number;
  /** Of `promptCount`, how many are sampled once regardless of the setting. */
  brandCheckCount?: number;
  costPerCall: Record<EngineId, number>;
  spentUsd: number;
}) {
  const [cadence, setCadence] = useState(defaults.cadence);
  const [dayOfWeek, setDayOfWeek] = useState(String(defaults.dayOfWeek));
  const [engines, setEngines] = useState<EngineId[]>(defaults.engines);
  const [samples, setSamples] = useState(String(defaults.samplesPerPrompt));
  const [cap, setCap] = useState(String(defaults.monthlyCapUsd));

  const capUsd = Number(cap);
  const estimate = monthlyEstimateUsd({
    promptCount,
    brandCheckCount,
    engines,
    samplesPerPrompt: Number(samples),
    cadence,
    costPerCall,
  });
  const callsPerRunPerEngine = callsPerRun(promptCount, brandCheckCount, Number(samples));

  // The lib rejects an empty engines array ({ ok:false, error:"engines" }):
  // an enabled feature with zero engines would look on and measure nothing,
  // so "stop running" is spelled cadence "off" or the /company switch. This
  // guard mirrors that rule client-side so the reason is readable BEFORE
  // the submit, instead of surfacing as a failed save.
  const noEngines = engines.length === 0;
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

      {/* A fieldset, not a bare <Label>: the label element had no control and
          no labelable descendant, so a screen-reader user met four unrelated
          switches with no group context. */}
      <fieldset className="space-y-2">
        <legend className="text-sm leading-none font-medium select-none">Engines</legend>
        {ENGINE_ORDER.map((engine) => (
          <div key={engine} className="space-y-0.5">
            <Label>
              <Switch
                checked={engines.includes(engine)}
                aria-label={ENGINE_LABEL[engine]}
                onCheckedChange={(checked) =>
                  setEngines((prev) =>
                    checked ? [...prev, engine] : prev.filter((entry) => entry !== engine)
                  )
                }
              />
              {ENGINE_LABEL[engine]}
            </Label>
            {/* One branch, not two: every engine currently costs something
                (Gemini's grounded calls included), so a "free within its
                allowance" arm would be copy no tenant can ever see. */}
            <p className="pl-11 text-xs text-muted-foreground">
              {`About $${(costPerCall[engine] * callsPerRunPerEngine).toFixed(
                2
              )} per run at your current prompt set.`}
            </p>
          </div>
        ))}
        {/* Hidden inputs carry the array: a Switch is not a form control. */}
        {engines.map((engine) => (
          <input key={engine} type="hidden" name="engines" value={engine} />
        ))}
        {noEngines && (
          <p className="text-xs text-destructive">
            Turn on at least one engine — with none on, runs are scheduled and measure nothing.
          </p>
        )}
      </fieldset>

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
        <Label htmlFor="ai-visibility-cap">Monthly cap</Label>
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
        {/* Said plainly rather than left to be discovered on a bill: a cap that
            silently covers only part of what the feature spends is worse than
            no cap. Reading the answers is a Claude call billed to `llm_usage`
            alongside every other generation in the product. */}
        <p className="text-xs text-muted-foreground">
          Covers engine calls — only engine calls count against this cap. Reading the answers costs a
          little on top and is billed with the rest of your workspace&apos;s AI usage.
        </p>
        <p className="text-xs text-muted-foreground" data-testid="ai-visibility-estimate">
          ≈ ${estimate.toFixed(2)}/month at current settings
        </p>
        {overCap && (
          <p className="text-xs text-destructive">
            That estimate is above your ${capUsd.toFixed(2)} cap, so runs will pause part-way through the
            month. Drop to 1 sample on the most expensive engine before dropping prompts.
          </p>
        )}
        {badCap && (
          <p className="text-xs text-destructive">
            Set a cap between ${MIN_MONTHLY_CAP_USD} and ${MAX_MONTHLY_CAP_USD} — the feature will not
            run without one, and will not accept a larger one.
          </p>
        )}
      </div>

      <Button type="submit" variant="outline" disabled={noEngines || badCap}>
        Save
      </Button>
    </form>
  );
}
