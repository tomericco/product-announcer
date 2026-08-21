import {
  asArray,
  isRecord,
  ENGINE_REQUEST_TIMEOUT_MS,
} from "@/lib/ai-visibility/engines/shape";
import {
  NEUTRAL_SYSTEM_PROMPT,
  type EngineAnswer,
  type EngineCitation,
  type EngineClient,
  type EngineError,
} from "@/lib/ai-visibility/types";

export const PERPLEXITY_LABEL = "Perplexity Sonar API";

/**
 * NOT VERIFIED LIVE — there is no PERPLEXITY_API_KEY in this deployment, and
 * `GET /v1/models` requires auth, so this comes from Perplexity's published
 * catalogue rather than from a call that worked.
 *
 * The Agent API takes PROVIDER-PREFIXED slugs: bare `sonar`, which the old
 * chat-completions endpoint accepted, is not a valid id here.
 */
export const PERPLEXITY_DEFAULT_MODEL = "perplexity/sonar";

/**
 * The Agent API, which replaces Sonar chat-completions.
 *
 * `POST /chat/completions` retires on 2026-09-27 — inside this feature's first
 * month of weekly runs — so it was never worth shipping against. Note that
 * `/v1/sonar` is NOT the replacement despite the name: it is a legacy ALIAS of
 * the retiring endpoint. `/v1/agent` and `/v1/responses` are the same surface;
 * `/v1/agent` is the one Perplexity's own migration guide uses for raw HTTP.
 */
const PERPLEXITY_ENDPOINT = "https://api.perplexity.ai/v1/agent";

/**
 * $2.50 per 1,000 web_search invocations, plus ~$0.002 of sonar tokens on a
 * short answer. Rounded up, per the estimate-high rule — though the response
 * also reports its own metered cost, which is preferred when present.
 */
export const PERPLEXITY_COST_PER_CALL_USD = 0.008;

type PerplexitySearchResult = { id?: number; url?: string; title?: string; snippet?: string };
type PerplexityOutputItem = {
  type?: string;
  /** On a `search_results` item. */
  results?: PerplexitySearchResult[];
  queries?: string[];
  /** On a `message` item. */
  content?: { type?: string; text?: string }[];
};
/**
 * A copy of the response with the per-result snippets dropped.
 *
 * Every search result carries a snippet of the source page. Useful to the model
 * mid-answer, dead weight afterwards: what gets stored and read back is the URL
 * and the title, and the quote shown in the UI comes from the judge. Modest per
 * sample, but `raw` is jsonb on all ~360 samples of every weekly run.
 */
function sanitizeRaw(raw: PerplexityResponse): PerplexityResponse {
  // No `output` key in, no `output` key out — `raw` is the evidence record.
  if (!Array.isArray(raw.output)) return raw;
  return {
    ...raw,
    output: raw.output.map((item) => {
      if (!isRecord(item) || !Array.isArray(item.results)) return item;
      return {
        ...item,
        results: item.results.map((result) => {
          if (!isRecord(result) || result.snippet === undefined) return result;
          const trimmed = { ...result };
          delete trimmed.snippet;
          return trimmed;
        }),
      };
    }),
  };
}

type PerplexityResponse = {
  model?: string;
  /** completed | failed | incomplete | in_progress | queued | cancelled */
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: PerplexityOutputItem[];
  usage?: { cost?: { total_cost?: number } };
};

/** What the call actually cost, if the response says; the flat estimate if not. */
function meteredCost(raw: PerplexityResponse): number {
  const metered = raw.usage?.cost?.total_cost;
  return typeof metered === "number" ? metered : PERPLEXITY_COST_PER_CALL_USD;
}

export async function askPerplexity(
  prompt: string,
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<EngineAnswer | EngineError> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    return { kind: "error", message: "PERPLEXITY_API_KEY is not set" };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const model = process.env.AI_VISIBILITY_PERPLEXITY_MODEL ?? PERPLEXITY_DEFAULT_MODEL;

  let response: Response;
  try {
    response = await fetchImpl(PERPLEXITY_ENDPOINT, {
      // Bounded, because the run slice's wall-clock budget is otherwise
      // advisory: a provider that accepts the connection and then never
      // answers holds a whole concurrency wave open past the budget, past the
      // sweep's deadline, and into the platform's own timeout — which kills
      // the invocation instead of recording an error. A timeout here becomes an
      // ordinary EngineError on one sample.
      signal: AbortSignal.timeout(ENGINE_REQUEST_TIMEOUT_MS),
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      // The Agent API is STRICT: any unknown field, at any depth, is a 400.
      // Nothing speculative goes in this body.
      body: JSON.stringify({
        model,
        instructions: NEUTRAL_SYSTEM_PROMPT,
        input: prompt,
        // Search is not implied here the way it was on Sonar chat-completions —
        // without this the model answers from memory, which measures training
        // data rather than the live web.
        tools: [{ type: "web_search" }],
      }),
    });
  } catch (error) {
    return { kind: "error", message: `perplexity request failed: ${String(error)}` };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { kind: "error", message: `perplexity ${response.status}: ${body.slice(0, 300)}` };
  }

  let raw: PerplexityResponse;
  try {
    raw = (await response.json()) as PerplexityResponse;
  } catch (error) {
    return { kind: "error", message: `perplexity returned unparseable JSON: ${String(error)}` };
  }
  if (!isRecord(raw)) {
    return { kind: "error", message: "perplexity returned a non-object body" };
  }

  // A failed or cancelled run comes back as HTTP 200 with a status field — so
  // branching on the HTTP code alone would file a failure as an empty answer.
  if (raw.status === "failed" || raw.status === "cancelled") {
    const detail = raw.error?.message ?? raw.status;
    return {
      kind: "error",
      message: `perplexity run ${raw.status}: ${detail}`,
      costUsd: meteredCost(raw),
    };
  }
  if (raw.status === "incomplete") {
    return {
      kind: "error",
      message: `perplexity answer incomplete: ${raw.incomplete_details?.reason ?? "unknown reason"}`,
      costUsd: meteredCost(raw),
    };
  }
  // An unfinished run is infrastructure, not the model declining to answer.
  // Without this it falls through to "no answer text" and gets filed as a
  // refusal — which would read on the dashboard as Perplexity choosing not to
  // engage with the prompt, when in fact we simply asked too early.
  if (raw.status === "in_progress" || raw.status === "queued") {
    return { kind: "error", message: `perplexity run still ${raw.status}` };
  }

  let text = "";
  const citations: EngineCitation[] = [];
  const searchQueries: string[] = [];
  const seen = new Set<string>();

  for (const item of asArray<PerplexityOutputItem>(raw.output)) {
    if (!isRecord(item)) continue;
    if (item.type === "message") {
      for (const part of asArray<{ type?: string; text?: string }>(item.content)) {
        if (!isRecord(part)) continue;
        if (part.type === "output_text" && typeof part.text === "string") text += part.text;
      }
      continue;
    }
    if (item.type !== "search_results") continue;
    for (const query of asArray<string>(item.queries)) {
      if (typeof query === "string" && query.length > 0 && !searchQueries.includes(query)) {
        searchQueries.push(query);
      }
    }
    // `annotations` on the message is documented as often empty, so the
    // search_results item is the source of truth for what was cited.
    for (const result of asArray<PerplexitySearchResult>(item.results)) {
      if (!isRecord(result)) continue;
      const url = result.url;
      if (typeof url !== "string" || url.length === 0 || seen.has(url)) continue;
      seen.add(url);
      citations.push({ url, position: citations.length + 1 });
    }
  }

  if (text.trim().length === 0) {
    return {
      kind: "refused",
      message: "perplexity returned no answer text",
      costUsd: meteredCost(raw),
    };
  }
  // An answer with zero sources means the search came back with nothing, which
  // is a coverage gap rather than a real miss.
  if (citations.length === 0) {
    return {
      kind: "refused",
      message: "perplexity answered with no search sources",
      costUsd: meteredCost(raw),
    };
  }

  return {
    text,
    modelId: raw.model ?? model,
    citations,
    searchUsed: true,
    searchQueries,
    raw: sanitizeRaw(raw),
    // The response meters its own spend. Preferred over the flat estimate,
    // which exists for the pre-run cap check where no response exists yet.
    costUsd: meteredCost(raw),
  };
}

export const perplexityEngine: EngineClient = {
  id: "perplexity",
  label: PERPLEXITY_LABEL,
  ask: askPerplexity,
};
