import {
  NEUTRAL_SYSTEM_PROMPT,
  type EngineAnswer,
  type EngineCitation,
  type EngineClient,
  type EngineError,
} from "@/lib/ai-visibility/types";

export const OPENAI_LABEL = "GPT-5.x API + web search";
export const OPENAI_DEFAULT_MODEL = "gpt-5.1";

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
  action?: { type?: string; query?: string };
};
type OpenAiResponse = { model?: string; output?: OpenAiOutputItem[] };

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
      const query = item.action?.query;
      if (typeof query === "string" && query.length > 0 && !searchQueries.includes(query)) {
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
    raw,
    costUsd: OPENAI_COST_PER_CALL_USD,
  };
}

export const openaiEngine: EngineClient = { id: "openai", label: OPENAI_LABEL, ask: askOpenAi };
