import {
  NEUTRAL_SYSTEM_PROMPT,
  type EngineAnswer,
  type EngineCitation,
  type EngineClient,
  type EngineError,
} from "@/lib/ai-visibility/types";

export const OPENAI_LABEL = "GPT-5.x API + web search";

/**
 * Verified against `GET /v1/models` on 2026-08-21, and with a live grounded
 * call that came back `gpt-5.5-2026-04-23`.
 *
 * The response reports the dated snapshot, which is what gets stored — a silent
 * snapshot roll is exactly the thing the run has to annotate rather than brief.
 */
export const OPENAI_DEFAULT_MODEL = "gpt-5.5";

/**
 * Flat per-call estimate, not a metered figure.
 *
 * $10 per 1,000 web searches is $0.010, plus roughly $0.002 of tokens on a
 * short grounded answer. The cap exists to bound spend, so the estimate is
 * deliberately on the high side: an over-estimate pauses a tenant early, an
 * under-estimate bills them past their cap.
 */
export const OPENAI_COST_PER_CALL_USD = 0.012;

type OpenAiAnnotation = { type?: string; url?: string };
type OpenAiContentPart = {
  type?: string;
  text?: string;
  refusal?: string;
  annotations?: OpenAiAnnotation[];
};
type OpenAiOutputItem = {
  type?: string;
  content?: OpenAiContentPart[];
  /**
   * `queries` (plural, an array) is what the live API returns; `query` is kept
   * as a fallback for the older singular shape. A search item can also be an
   * `open_page` or `find_in_page` action, which carries a `url`/`pattern` and
   * no query at all — those are navigation, not a search, so they contribute
   * nothing here beyond proving the model searched.
   */
  action?: { type?: string; query?: string; queries?: string[]; url?: string };
  encrypted_content?: string;
};
type OpenAiResponse = {
  model?: string;
  output?: OpenAiOutputItem[];
  /** "completed" | "incomplete" | "failed" | … */
  status?: string;
  incomplete_details?: { reason?: string } | null;
};

/**
 * A copy of the response with the opaque blobs dropped.
 *
 * Reasoning items carry a base64 `encrypted_content` that is nothing but a
 * continuation handle — unreadable, useless once the call is over, and large:
 * it was the bulk of a 24 KB response in a live check. `raw` is stored as jsonb
 * on every sample, so at ~360 samples a run this is the difference between a
 * few MB and a few hundred.
 */
function sanitizeRaw(raw: OpenAiResponse): OpenAiResponse {
  return {
    ...raw,
    output: (raw.output ?? []).map((item) => {
      if (item.encrypted_content === undefined) return item;
      const copy = { ...item };
      delete copy.encrypted_content;
      return copy;
    }),
  };
}

export async function askOpenAi(
  prompt: string,
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<EngineAnswer | EngineError> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    return { kind: "error", message: "OPENAI_API_KEY is not set" };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const model = process.env.AI_VISIBILITY_OPENAI_MODEL ?? OPENAI_DEFAULT_MODEL;

  let response: Response;
  try {
    response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        instructions: NEUTRAL_SYSTEM_PROMPT,
        input: prompt,
        // No temperature: the natural distribution IS the measurement.
        tools: [{ type: "web_search", search_context_size: "medium" }],
      }),
    });
  } catch (error) {
    return { kind: "error", message: `openai request failed: ${String(error)}` };
  }

  // 429 and 5xx are errors, not misses: the sample is stored with status
  // `error` and excluded from every rate, so a rate-limited engine reads as a
  // coverage gap rather than as "they never named you".
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { kind: "error", message: `openai ${response.status}: ${body.slice(0, 300)}` };
  }

  let raw: OpenAiResponse;
  try {
    raw = (await response.json()) as OpenAiResponse;
  } catch (error) {
    return { kind: "error", message: `openai returned unparseable JSON: ${String(error)}` };
  }

  const searchQueries: string[] = [];
  const citations: EngineCitation[] = [];
  const seen = new Set<string>();
  let searchUsed = false;
  let refused = false;
  let text = "";

  for (const item of raw.output ?? []) {
    if (item.type === "web_search_call") {
      searchUsed = true;
      const queries = [...(item.action?.queries ?? []), item.action?.query];
      for (const query of queries) {
        if (typeof query !== "string" || query.length === 0) continue;
        if (searchQueries.includes(query)) continue;
        searchQueries.push(query);
      }
      continue;
    }
    for (const part of item.content ?? []) {
      if (part.type === "refusal") {
        refused = true;
        continue;
      }
      if (typeof part.text === "string") text += part.text;
      for (const annotation of part.annotations ?? []) {
        if (annotation.type !== "url_citation") continue;
        const url = annotation.url;
        if (typeof url !== "string" || url.length === 0 || seen.has(url)) continue;
        // One source cited twice is one source. Position is where it FIRST
        // appeared, which is what the leaderboard ranks on.
        seen.add(url);
        citations.push({ url, position: citations.length + 1 });
      }
    }
  }

  // A cut-off answer is NOT a measurement. If the model was still writing when
  // the budget ran out, a brand named in the missing tail scores as absent —
  // a false negative in the one number this whole feature reports. An error
  // makes the sample a visible coverage gap instead.
  if (raw.incomplete_details) {
    return {
      kind: "error",
      message: `openai answer incomplete: ${raw.incomplete_details.reason ?? "unknown reason"}`,
    };
  }
  if (typeof raw.status === "string" && raw.status !== "completed") {
    return { kind: "error", message: `openai response status ${raw.status}` };
  }

  if (refused) return { kind: "refused", message: "openai refused the prompt" };
  if (text.trim().length === 0) {
    return { kind: "refused", message: "openai returned no answer text" };
  }
  // An answer written from the model's own memory measures training data, not
  // the live web. Stored, shown as a coverage gap, excluded from rates.
  if (!searchUsed) return { kind: "refused", message: "openai answered without searching the web" };

  return {
    text,
    modelId: raw.model ?? model,
    citations,
    searchUsed,
    searchQueries,
    raw: sanitizeRaw(raw),
    costUsd: OPENAI_COST_PER_CALL_USD,
  };
}

export const openaiEngine: EngineClient = { id: "openai", label: OPENAI_LABEL, ask: askOpenAi };
