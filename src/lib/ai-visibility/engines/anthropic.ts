import {
  asArray,
  isRecord,
  ENGINE_REQUEST_TIMEOUT_MS,
} from "@/lib/ai-visibility/engines/shape";
import {
  engineSystemPrompt,
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
/**
 * Verified live on 2026-08-21, both by `GET /v1/models` and by real calls.
 *
 * To be precise about why this moved, since the obvious guess is wrong: the
 * previous `claude-sonnet-4-5` DOES still resolve — it aliases to the dated
 * `claude-sonnet-4-5-20250929`, and a call on it returns 200. It was changed
 * because 4.5 is legacy and carries the earliest retirement date of any active
 * model, and this feature's whole value is a metric that stays comparable week
 * over week. A retirement mid-series would break the sparkline exactly like a
 * silent model swap does.
 */
export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5";
export const ANTHROPIC_API_VERSION = "2023-06-01";

/** $10 per 1,000 searches plus ~$0.002 of tokens on a short answer. */
export const ANTHROPIC_COST_PER_CALL_USD = 0.012;

/**
 * Measured, not guessed. A live grounded call at 1,024 with thinking left on
 * stopped at `max_tokens` mid-sentence; the same question with thinking off
 * finished at 1,293 output tokens. 4,096 leaves headroom for a longer answer
 * without inviting an essay, and truncation is now an error anyway.
 */
const ANTHROPIC_MAX_TOKENS = 4_096;
/** A buyer question needs a handful of searches, not a research session. */
const ANTHROPIC_MAX_SEARCHES = 5;

type AnthropicSearchResult = {
  type?: string;
  url?: string;
  title?: string;
  encrypted_content?: string;
  page_age?: string;
};
type AnthropicCitation = {
  type?: string;
  url?: string;
  title?: string;
  cited_text?: string;
  encrypted_index?: string;
};
type AnthropicBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: { query?: string };
  citations?: AnthropicCitation[];
  /** Present on `web_search_tool_result`: the raw hits behind the answer. */
  content?: AnthropicSearchResult[];
};
type AnthropicResponse = { model?: string; stop_reason?: string; content?: AnthropicBlock[] };

/**
 * A copy of the response with the bulk dropped.
 *
 * `web_search_tool_result[].content[].encrypted_content` is a base64 blob per
 * search hit — a live call returned 17 hits and weighed 47 KB, of which 38 KB
 * was blobs. `raw` is stored as jsonb on every sample, so across ~270 samples a
 * run that is the difference between ~3 MB and ~17 MB a week, for bytes nothing
 * can read. `cited_text` and `encrypted_index` go the same way: the quote shown
 * in the UI comes from the judge, not from here.
 */
function sanitizeRaw(raw: AnthropicResponse): AnthropicResponse {
  // No `content` key in, no `content` key out — `raw` is the evidence record,
  // and an invented empty array would misreport what the provider said.
  if (!Array.isArray(raw.content)) return raw;
  return {
    ...raw,
    content: raw.content.map((block) => {
      if (!isRecord(block)) return block;
      const copy = { ...block };
      if (Array.isArray(copy.content)) {
        copy.content = copy.content.map((result) => {
          if (!isRecord(result)) return result;
          const trimmed = { ...result };
          delete trimmed.encrypted_content;
          delete trimmed.page_age;
          return trimmed;
        });
      }
      if (Array.isArray(copy.citations)) {
        copy.citations = copy.citations.map((citation) => {
          if (!isRecord(citation)) return citation;
          const trimmed = { ...citation };
          delete trimmed.cited_text;
          delete trimmed.encrypted_index;
          return trimmed;
        });
      }
      return copy;
    }),
  };
}

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
      // Bounded, because the run slice's wall-clock budget is otherwise
      // advisory: a provider that accepts the connection and then never
      // answers holds a whole concurrency wave open past the budget, past the
      // sweep's deadline, and into the platform's own timeout — which kills
      // the invocation instead of recording an error. A timeout here becomes an
      // ordinary EngineError on one sample.
      signal: AbortSignal.timeout(ENGINE_REQUEST_TIMEOUT_MS),
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        // Sonnet 5 thinks by default, and thinking tokens come out of the same
        // budget as the answer — a live check spent so many of them that the
        // answer itself was cut off. What is being measured is the answer a
        // buyer would read, not the reasoning behind it.
        thinking: { type: "disabled" },
        // Omitted entirely when unset — Anthropic treats an empty system
        // string as a real (empty) instruction.
        ...(engineSystemPrompt() ? { system: engineSystemPrompt() } : {}),
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
  if (!isRecord(raw)) {
    return { kind: "error", message: "anthropic returned a non-object body" };
  }

  // Every return below this point follows a complete, readable response, so the
  // call was billed whatever its verdict — see `EngineError.costUsd`.
  if (raw.stop_reason === "refusal") {
    return {
      kind: "refused",
      message: "anthropic refused the prompt",
      costUsd: ANTHROPIC_COST_PER_CALL_USD,
    };
  }
  // A cut-off answer is not a measurement: a brand named in the tail that never
  // got written would score as absent, which is a false negative in the
  // headline number. `pause_turn` is the same story — the turn is unfinished.
  // Both become coverage gaps rather than quiet zeroes.
  if (raw.stop_reason === "max_tokens" || raw.stop_reason === "pause_turn") {
    return {
      kind: "error",
      message: `anthropic answer incomplete: ${raw.stop_reason}`,
      costUsd: ANTHROPIC_COST_PER_CALL_USD,
    };
  }

  const searchQueries: string[] = [];
  const citations: EngineCitation[] = [];
  const seen = new Set<string>();
  let searchUsed = false;
  let text = "";

  for (const block of asArray<AnthropicBlock>(raw.content)) {
    if (!isRecord(block)) continue;
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
    for (const citation of asArray<AnthropicCitation>(block.citations)) {
      if (!isRecord(citation)) continue;
      const url = citation.url;
      if (typeof url !== "string" || url.length === 0 || seen.has(url)) continue;
      seen.add(url);
      citations.push({ url, position: citations.length + 1 });
    }
  }

  if (text.trim().length === 0) {
    return {
      kind: "refused",
      message: "anthropic returned no answer text",
      costUsd: ANTHROPIC_COST_PER_CALL_USD,
    };
  }
  if (!searchUsed) {
    return {
      kind: "refused",
      message: "anthropic answered without searching the web",
      costUsd: ANTHROPIC_COST_PER_CALL_USD,
    };
  }

  return {
    text,
    modelId: raw.model ?? model,
    citations,
    searchUsed,
    searchQueries,
    raw: sanitizeRaw(raw),
    costUsd: ANTHROPIC_COST_PER_CALL_USD,
  };
}

export const anthropicEngine: EngineClient = {
  id: "anthropic",
  label: ANTHROPIC_LABEL,
  ask: askAnthropic,
};
