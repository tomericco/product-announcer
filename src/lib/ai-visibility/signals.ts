import { MIN_N_PROMPT } from "@/lib/ai-visibility/metrics";
import type {
  AiVisibilityPayload,
  AiVisibilitySignalType,
  EngineId,
} from "@/lib/ai-visibility/types";

/** Design §Signals: "capped at ~10 per run ranked by materiality". */
export const MAX_SIGNALS_PER_RUN = 10;
/** "≥2/3" throughout the spec's trigger table. */
export const STRONG = 2 / 3;
/** "<1/3" in the competitor_gained rule. */
export const WEAK = 1 / 3;
/** "engine SOV moving ≥10 pp window-over-window". */
export const ENGINE_SOV_MOVE_PP = 10;
/** Excerpt cap from the spec's evidence payload. */
const MAX_EXCERPT_CHARS = 400;
/** Prompt text is a whole question; titles get a readable slice of it. */
const TITLE_PROMPT_CHARS = 70;

/**
 * The signals that assert something MOVED, and are therefore suppressed for an
 * engine whose model id changed this run (design §Signals, and the risk
 * register's "Model changes" line).
 *
 * `gap_vs_competitor`, `recommended_not_cited` and `misdescription` are
 * deliberately absent: each describes a standing state that is no less true
 * under a new model. Suppressing them would silence the feature's most useful
 * signal every time a provider ships a version, which is often.
 */
export const CHANGE_SIGNAL_TYPES: readonly AiVisibilitySignalType[] = [
  "lost_mention",
  "gained_mention",
  "competitor_gained",
  "new_cited_domain",
  "own_page_cited",
];

/**
 * Materiality weights for the per-run cap.
 *
 * Ordered by what a content marketer can act on this week. A gap where a
 * competitor owns the answer is a brief; a first own-page citation is
 * encouraging but does not commission anything.
 */
const TYPE_WEIGHT: Record<AiVisibilitySignalType, number> = {
  gap_vs_competitor: 100,
  lost_mention: 95,
  recommended_not_cited: 90,
  competitor_gained: 85,
  misdescription: 80,
  new_cited_domain: 60,
  own_page_cited: 55,
  gained_mention: 50,
};

/**
 * `2026-W10`. ISO week *year*, not calendar year — they differ at the boundary.
 *
 * Computed from UTC components, NOT via date-fns: `getISOWeek` reads the
 * process timezone, so near a week boundary the same run would dedupe under
 * different keys on a UTC server and on a dev machine in another timezone.
 * The algorithm is the classic one — shift to the Thursday of the date's ISO
 * week, then count weeks from that ISO year's January 1st.
 */
export function isoWeekKey(date: Date): string {
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO weekday (Mon=1 … Sun=7); move to this week's Thursday, which always
  // lies inside the ISO week year.
  const isoDay = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - isoDay);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * Which band a run's result for one prompt on one engine falls in.
 *
 * `null` below `MIN_N_PROMPT` means "not measurable", which is NOT the same as
 * "absent" and must never be treated as one — a run where the engine errored
 * twice out of three would otherwise read as a lost mention and commission a
 * brief about nothing.
 */
export function band(hits: number, n: number): "absent" | "weak" | "strong" | null {
  if (n < MIN_N_PROMPT) return null;
  if (hits === 0) return "absent";
  return hits / n >= STRONG ? "strong" : "weak";
}

export type RunBand = {
  runId: string;
  hits: number;
  n: number;
  /** competitorId -> samples in this run naming that competitor. */
  competitorHits: Record<string, number>;
};

export type SignalEvidence = {
  excerpt: string | null;
  modelId: string | null;
  citedUrls: { url: string; domain: string; domainClass: string }[];
};

export type PromptEngineWindow = {
  promptId: string;
  promptText: string;
  branded: boolean;
  engine: EngineId;
  /** Most recent first, this run at index 0, up to WINDOW_RUNS entries. */
  runs: RunBand[];
  nWindow: number;
  recommendationsWindow: number;
  ownCitationsWindow: number;
  /** Own-domain citations in any run OLDER than the window — the "first ever" test. */
  ownCitationsBefore: number;
  contradictionSamples: number;
  evidence: SignalEvidence;
};

export type EngineWindow = {
  engine: EngineId;
  sovNow: number | null;
  sovPrev: number | null;
  competitorSharesNow: Record<string, number>;
  competitorSharesPrev: Record<string, number>;
  modelChanged: boolean;
  modelId: string | null;
};

export type DomainWindow = {
  domain: string;
  domainClass: string;
  /** 1-based position in this window's cited-domain leaderboard. */
  rank: number;
  seenBefore: boolean;
  promptsTenantAbsent: number;
  engines: EngineId[];
  sampleUrl: string;
};

export type TriggerInput = {
  runId: string;
  runDate: Date;
  prompts: PromptEngineWindow[];
  engines: EngineWindow[];
  domains: DomainWindow[];
  competitorNames: Record<string, string>;
  engineLabels: Record<string, string>;
};

export type SignalCandidate = {
  externalId: string;
  signalType: AiVisibilitySignalType;
  title: string;
  excerpt: string | null;
  competitorId: string | null;
  score: number;
  payload: AiVisibilityPayload;
};

/**
 * Contract decision 6's scheme, with one documented deviation: the middle
 * slot is the signal's SUBJECT — the promptId, the domain, or (for
 * `competitor_gained`, which has neither) the competitorId — falling back to
 * "all" only when the signal genuinely has no subject (the engine-wide
 * `lost_mention` summary). Under the contract's literal
 * `promptId ?? domain ?? "all"`, two competitors gaining on the same engine
 * in the same ISO week would collide on one key and `onConflictDoNothing`
 * would silently drop the second — a materially different signal.
 */
function externalId(
  signalType: AiVisibilitySignalType,
  subject: string | null,
  engine: EngineId | null,
  isoWeek: string
): string {
  return `${signalType}:${subject ?? "all"}:${engine ?? "all"}:${isoWeek}`;
}

function shortPrompt(text: string): string {
  return text.length > TITLE_PROMPT_CHARS ? `${text.slice(0, TITLE_PROMPT_CHARS - 1)}…` : text;
}

/** Design §Signals evidence payload: `"0 of 3, two runs"`. */
function samplesLabel(hits: number, n: number, runs: number): string {
  const runWord = runs === 1 ? "one run" : runs === 2 ? "two runs" : `${runs} runs`;
  return `${hits} of ${n}, ${runWord}`;
}

export function evaluateTriggers(input: TriggerInput): SignalCandidate[] {
  const isoWeek = isoWeekKey(input.runDate);
  const runDate = input.runDate.toISOString();
  const byEngine = new Map(input.engines.map((e) => [e.engine, e]));
  const changedEngines = new Set(input.engines.filter((e) => e.modelChanged).map((e) => e.engine));

  const candidates: SignalCandidate[] = [];

  const make = (a: {
    signalType: AiVisibilitySignalType;
    subject: string | null;
    engine: EngineId | null;
    title: string;
    excerpt: string | null;
    competitorId?: string | null;
    weight: number;
    payload: Partial<AiVisibilityPayload>;
  }) => {
    candidates.push({
      externalId: externalId(a.signalType, a.subject, a.engine, isoWeek),
      signalType: a.signalType,
      title: a.title,
      excerpt: a.excerpt ? a.excerpt.slice(0, MAX_EXCERPT_CHARS) : null,
      competitorId: a.competitorId ?? null,
      // Type weight dominates; evidence volume only breaks ties within a type.
      score: TYPE_WEIGHT[a.signalType] * 1_000 + a.weight,
      payload: {
        signalType: a.signalType,
        runId: input.runId,
        runDate,
        samples: "",
        ...a.payload,
      } as AiVisibilityPayload,
    });
  };

  const engineLabel = (engine: EngineId) => input.engineLabels[engine] ?? engine;
  const competitorName = (id: string) => input.competitorNames[id] ?? "A competitor";

  // ── Engine-level SOV summary, first: it decides what the per-prompt pass
  //    may emit for that engine. Design §Signals: a ≥10 pp engine move emits
  //    ONE summary "rather than per-prompt ones".
  const summarisedEngines = new Set<EngineId>();
  for (const engine of input.engines) {
    if (engine.sovNow === null || engine.sovPrev === null) continue;
    const movePp = engine.sovNow - engine.sovPrev;
    // Falls only. A rise is covered by the per-prompt gained_mention rule, which
    // has a two-run hold; the spec names only these two summary types and both
    // describe losing ground.
    if (movePp > -ENGINE_SOV_MOVE_PP) continue;
    summarisedEngines.add(engine.engine);
    if (changedEngines.has(engine.engine)) continue;

    // Whoever took the share, if anyone did — that is the difference between a
    // brief with a named subject and one without.
    let riser: string | null = null;
    let riserPp = 0;
    for (const [id, now] of Object.entries(engine.competitorSharesNow)) {
      const gain = now - (engine.competitorSharesPrev[id] ?? 0);
      if (gain >= ENGINE_SOV_MOVE_PP && gain > riserPp) {
        riser = id;
        riserPp = gain;
      }
    }

    const drop = Math.abs(movePp).toFixed(0);
    if (riser) {
      make({
        signalType: "competitor_gained",
        // The competitor IS the subject: two different risers on one engine in
        // one week are two different signals and must not share a dedupe key.
        subject: riser,
        engine: engine.engine,
        title: `${competitorName(riser)} gained ${riserPp.toFixed(0)} points of share on ${engineLabel(engine.engine)}`,
        excerpt: null,
        competitorId: riser,
        weight: riserPp,
        payload: {
          engine: engine.engine,
          engineLabel: engineLabel(engine.engine),
          modelId: engine.modelId ?? undefined,
          competitorId: riser,
          samples: `share of voice ${engine.sovPrev.toFixed(0)}% to ${engine.sovNow.toFixed(0)}%`,
        },
      });
    } else {
      make({
        signalType: "lost_mention",
        subject: null,
        engine: engine.engine,
        title: `Share of voice fell ${drop} points on ${engineLabel(engine.engine)}`,
        excerpt: null,
        weight: Math.abs(movePp),
        payload: {
          engine: engine.engine,
          engineLabel: engineLabel(engine.engine),
          modelId: engine.modelId ?? undefined,
          samples: `share of voice ${engine.sovPrev.toFixed(0)}% to ${engine.sovNow.toFixed(0)}%`,
        },
      });
    }
  }

  /** May this per-prompt signal be emitted for this engine on this run? */
  const allowed = (signalType: AiVisibilitySignalType, engine: EngineId): boolean => {
    if (!CHANGE_SIGNAL_TYPES.includes(signalType)) return true;
    if (changedEngines.has(engine)) return false;
    if (summarisedEngines.has(engine)) return false;
    return true;
  };

  // ── Per prompt x engine ────────────────────────────────────────────────
  const competitorGains = new Map<string, { competitorId: string; engine: EngineId; prompts: string[] }>();

  for (const p of input.prompts) {
    const [now, prev, before] = p.runs;
    const nowBand = now ? band(now.hits, now.n) : null;
    const prevBand = prev ? band(prev.hits, prev.n) : null;
    const beforeBand = before ? band(before.hits, before.n) : null;
    const label = engineLabel(p.engine);

    const basePayload = {
      promptId: p.promptId,
      promptText: p.promptText,
      engine: p.engine,
      engineLabel: label,
      modelId: p.evidence.modelId ?? undefined,
      citedUrls: p.evidence.citedUrls,
    };

    // 1. gap_vs_competitor — a competitor strong and us absent, TWO runs.
    if (!p.branded && now && prev && nowBand === "absent" && prevBand === "absent") {
      const contenders = Object.keys(now.competitorHits).filter(
        (id) =>
          band(now.competitorHits[id] ?? 0, now.n) === "strong" &&
          band(prev.competitorHits[id] ?? 0, prev.n) === "strong"
      );
      // Most-mentioned this run wins, so the brief names the competitor actually
      // owning the answer rather than whichever id sorted first.
      const winner = contenders.sort(
        (a, b) => (now.competitorHits[b] ?? 0) - (now.competitorHits[a] ?? 0) || a.localeCompare(b)
      )[0];
      if (winner && allowed("gap_vs_competitor", p.engine)) {
        make({
          signalType: "gap_vs_competitor",
          subject: p.promptId,
          engine: p.engine,
          title: `Absent from "${shortPrompt(p.promptText)}" on ${label} — ${competitorName(winner)} named ${now.competitorHits[winner]} of ${now.n}`,
          excerpt: p.evidence.excerpt,
          competitorId: winner,
          weight: p.nWindow,
          payload: { ...basePayload, competitorId: winner, samples: samplesLabel(0, now.n, 2) },
        });
      }
    }

    // 2. lost_mention — strong, then absent held for two runs.
    if (nowBand === "absent" && prevBand === "absent" && beforeBand === "strong" && allowed("lost_mention", p.engine)) {
      make({
        signalType: "lost_mention",
        subject: p.promptId,
        engine: p.engine,
        title: `No longer named for "${shortPrompt(p.promptText)}" on ${label}`,
        excerpt: p.evidence.excerpt,
        weight: p.nWindow,
        payload: { ...basePayload, samples: samplesLabel(0, now!.n, 2) },
      });
    }

    // 3. gained_mention — absent, then strong held for two consecutive runs
    //    (spec trigger table: "0/3 → ≥2/3, two runs", mirroring lost_mention's
    //    two consecutive absents). A merely-weak previous run (1/3) does NOT
    //    qualify: 3/3 after 1/3 after 0/3 is half noise, not a gain worth a
    //    brief.
    if (nowBand === "strong" && prevBand === "strong" && beforeBand === "absent" && allowed("gained_mention", p.engine)) {
      make({
        signalType: "gained_mention",
        subject: p.promptId,
        engine: p.engine,
        title: `Now named for "${shortPrompt(p.promptText)}" on ${label}`,
        excerpt: p.evidence.excerpt,
        weight: p.nWindow,
        payload: { ...basePayload, samples: samplesLabel(now!.hits, now!.n, 2) },
      });
    }

    // 4. competitor_gained — collected here, emitted once per (competitor,
    //    engine) below, because the rule counts across prompts.
    if (now && prev) {
      for (const [id, hits] of Object.entries(now.competitorHits)) {
        const wasBelowAThird = (prev.competitorHits[id] ?? 0) / Math.max(1, prev.n) < WEAK;
        if (band(hits, now.n) !== "strong" || !wasBelowAThird) continue;
        const key = `${id} ${p.engine}`;
        const entry = competitorGains.get(key) ?? { competitorId: id, engine: p.engine, prompts: [] };
        entry.prompts.push(p.promptId);
        competitorGains.set(key, entry);
      }
    }

    // 5. own_page_cited — the FIRST own-URL citation on this prompt, ever.
    if (p.ownCitationsWindow > 0 && p.ownCitationsBefore === 0 && allowed("own_page_cited", p.engine)) {
      make({
        signalType: "own_page_cited",
        subject: p.promptId,
        engine: p.engine,
        title: `Your page is cited for "${shortPrompt(p.promptText)}" on ${label}`,
        excerpt: p.evidence.excerpt,
        weight: p.ownCitationsWindow,
        payload: { ...basePayload, samples: samplesLabel(p.ownCitationsWindow, p.nWindow, p.runs.length) },
      });
    }

    // 6. recommended_not_cited — the engine advises us and cites someone else.
    if (
      p.nWindow >= MIN_N_PROMPT &&
      p.recommendationsWindow / p.nWindow >= STRONG &&
      p.ownCitationsWindow === 0 &&
      allowed("recommended_not_cited", p.engine)
    ) {
      make({
        signalType: "recommended_not_cited",
        subject: p.promptId,
        engine: p.engine,
        title: `Recommended for "${shortPrompt(p.promptText)}" on ${label}, but no page of yours is cited`,
        excerpt: p.evidence.excerpt,
        weight: p.recommendationsWindow,
        payload: {
          ...basePayload,
          samples: samplesLabel(p.recommendationsWindow, p.nWindow, p.runs.length),
        },
      });
    }

    // 7. misdescription — a positioning claim contradicted, or a fact invented,
    //    in at least two samples. One is a fluke; two is a pattern worth a page.
    if (p.contradictionSamples >= 2 && allowed("misdescription", p.engine)) {
      make({
        signalType: "misdescription",
        subject: p.promptId,
        engine: p.engine,
        title: `Your positioning is contradicted for "${shortPrompt(p.promptText)}" on ${label}`,
        excerpt: p.evidence.excerpt,
        weight: p.contradictionSamples,
        payload: {
          ...basePayload,
          samples: samplesLabel(p.contradictionSamples, p.nWindow, p.runs.length),
        },
      });
    }
  }

  for (const entry of competitorGains.values()) {
    if (entry.prompts.length < 3) continue;
    if (!allowed("competitor_gained", entry.engine)) continue;
    make({
      signalType: "competitor_gained",
      // As with the engine-SOV riser above: keyed by competitor, so distinct
      // competitors gaining on the same engine never dedupe each other away.
      subject: entry.competitorId,
      engine: entry.engine,
      title: `${competitorName(entry.competitorId)} gained mentions on ${entry.prompts.length} prompts on ${engineLabel(entry.engine)}`,
      excerpt: null,
      competitorId: entry.competitorId,
      weight: entry.prompts.length,
      payload: {
        engine: entry.engine,
        engineLabel: engineLabel(entry.engine),
        modelId: byEngine.get(entry.engine)?.modelId ?? undefined,
        competitorId: entry.competitorId,
        samples: `${entry.prompts.length} prompts, two runs`,
      },
    });
  }

  // 8. new_cited_domain — a domain the engines newly lean on.
  for (const domain of input.domains) {
    if (domain.seenBefore) continue;
    if (domain.rank > 10 && domain.promptsTenantAbsent < 3) continue;
    // A domain has no single engine, so the whole signal is suppressed if any
    // engine that cited it changed model this run: the "new" is unreliable.
    if (domain.engines.some((engine) => changedEngines.has(engine))) continue;

    make({
      signalType: "new_cited_domain",
      subject: domain.domain,
      engine: null,
      title:
        domain.promptsTenantAbsent > 0
          ? `${domain.domain} is now cited on ${domain.promptsTenantAbsent} prompts where you are absent`
          : `${domain.domain} is now among the most-cited sources`,
      excerpt: null,
      weight: domain.promptsTenantAbsent * 10 + Math.max(0, 20 - domain.rank),
      payload: {
        domain: domain.domain,
        citedUrls: [{ url: domain.sampleUrl, domain: domain.domain, domainClass: domain.domainClass }],
        samples: `${domain.promptsTenantAbsent} prompts, rank ${domain.rank}`,
      },
    });
  }

  // Deterministic: score, then externalId. The same run always produces the
  // same ten, which is what makes the dedupe key meaningful across retries.
  return candidates
    .sort((a, b) => b.score - a.score || a.externalId.localeCompare(b.externalId))
    .slice(0, MAX_SIGNALS_PER_RUN);
}
