import {
  NEUTRAL_SYSTEM_PROMPT,
  type EngineAnswer,
  type EngineCitation,
  type EngineClient,
  type EngineError,
} from "@/lib/ai-visibility/types";

export const PERPLEXITY_LABEL = "Perplexity Sonar API";
export const PERPLEXITY_DEFAULT_MODEL = "sonar";

/** $5 per 1,000 requests on base Sonar plus ~$0.003 of tokens on a short answer. */
export const PERPLEXITY_COST_PER_CALL_USD = 0.008;

type PerplexityResponse = {
  model?: string;
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  /** The richer, ordered form. Preferred when present. */
  search_results?: { url?: string; title?: string }[];
  /** The older flat form, still returned by some models. */
  citations?: string[];
};

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
    response = await fetchImpl("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: NEUTRAL_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
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

  const text = raw.choices?.[0]?.message?.content ?? "";
  if (text.trim().length === 0) {
    return { kind: "refused", message: "perplexity returned no answer text" };
  }

  // `search_results` first: it is the ordered, titled form. The flat
  // `citations` array is the older shape and some models still return only it.
  const urls =
    raw.search_results && raw.search_results.length > 0
      ? raw.search_results.map((result) => result.url)
      : (raw.citations ?? []);

  const citations: EngineCitation[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (typeof url !== "string" || url.length === 0 || seen.has(url)) continue;
    seen.add(url);
    citations.push({ url, position: citations.length + 1 });
  }

  // Sonar always searches; an answer with zero sources means the search came
  // back with nothing, which is a coverage gap rather than a real miss.
  if (citations.length === 0) {
    return { kind: "refused", message: "perplexity answered with no search sources" };
  }

  return {
    text,
    modelId: raw.model ?? model,
    citations,
    searchUsed: true,
    // Sonar does not report the queries it issued. Empty rather than a guess:
    // the monthly prompt expansion reads these and would otherwise mine the
    // prompt back out of itself.
    searchQueries: [],
    raw,
    costUsd: PERPLEXITY_COST_PER_CALL_USD,
  };
}

export const perplexityEngine: EngineClient = {
  id: "perplexity",
  label: PERPLEXITY_LABEL,
  ask: askPerplexity,
};
