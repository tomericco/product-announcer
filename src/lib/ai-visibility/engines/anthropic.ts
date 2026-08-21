import {
  NEUTRAL_SYSTEM_PROMPT,
  type EngineAnswer,
  type EngineCitation,
  type EngineClient,
  type EngineError,
} from "@/lib/ai-visibility/types";

export const ANTHROPIC_LABEL = "Claude API + web search";

/**
 * A BARE model id, not a gateway-style spec.
 *
 * This client speaks raw HTTP to `api.anthropic.com` — it does not go through
 * `@ai-sdk/anthropic`, so `resolveModel`/`modelId` are not involved and an
 * "anthropic/" prefix would be sent to the API verbatim and rejected.
 */
export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-5";
export const ANTHROPIC_API_VERSION = "2023-06-01";

/** $10 per 1,000 searches plus ~$0.002 of tokens on a short answer. */
export const ANTHROPIC_COST_PER_CALL_USD = 0.012;

/** Answers longer than this are not a measurement, they are an essay. */
const ANTHROPIC_MAX_TOKENS = 2_048;
/** A buyer question needs a handful of searches, not a research session. */
const ANTHROPIC_MAX_SEARCHES = 5;

type AnthropicBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: { query?: string };
  citations?: { type?: string; url?: string }[];
};
type AnthropicResponse = { model?: string; stop_reason?: string; content?: AnthropicBlock[] };

export async function askAnthropic(
  prompt: string,
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<EngineAnswer | EngineError> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    return { kind: "error", message: "ANTHROPIC_API_KEY is not set" };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const model = process.env.AI_VISIBILITY_ANTHROPIC_MODEL ?? ANTHROPIC_DEFAULT_MODEL;

  let response: Response;
  try {
    response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        system: NEUTRAL_SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
        tools: [
          { type: "web_search_20250305", name: "web_search", max_uses: ANTHROPIC_MAX_SEARCHES },
        ],
      }),
    });
  } catch (error) {
    return { kind: "error", message: `anthropic request failed: ${String(error)}` };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { kind: "error", message: `anthropic ${response.status}: ${body.slice(0, 300)}` };
  }

  let raw: AnthropicResponse;
  try {
    raw = (await response.json()) as AnthropicResponse;
  } catch (error) {
    return { kind: "error", message: `anthropic returned unparseable JSON: ${String(error)}` };
  }

  if (raw.stop_reason === "refusal") {
    return { kind: "refused", message: "anthropic refused the prompt" };
  }

  const searchQueries: string[] = [];
  const citations: EngineCitation[] = [];
  const seen = new Set<string>();
  let searchUsed = false;
  let text = "";

  for (const block of raw.content ?? []) {
    if (block.type === "server_tool_use" && block.name === "web_search") {
      searchUsed = true;
      const query = block.input?.query;
      if (typeof query === "string" && query.length > 0 && !searchQueries.includes(query)) {
        searchQueries.push(query);
      }
      continue;
    }
    if (block.type !== "text") continue;
    if (typeof block.text === "string") text += block.text;
    // Citations hang off the text block that used them, so this order is the
    // order the answer actually cited in.
    for (const citation of block.citations ?? []) {
      const url = citation.url;
      if (typeof url !== "string" || url.length === 0 || seen.has(url)) continue;
      seen.add(url);
      citations.push({ url, position: citations.length + 1 });
    }
  }

  if (text.trim().length === 0) {
    return { kind: "refused", message: "anthropic returned no answer text" };
  }
  if (!searchUsed) {
    return { kind: "refused", message: "anthropic answered without searching the web" };
  }

  return {
    text,
    modelId: raw.model ?? model,
    citations,
    searchUsed,
    searchQueries,
    raw,
    costUsd: ANTHROPIC_COST_PER_CALL_USD,
  };
}

export const anthropicEngine: EngineClient = {
  id: "anthropic",
  label: ANTHROPIC_LABEL,
  ask: askAnthropic,
};
