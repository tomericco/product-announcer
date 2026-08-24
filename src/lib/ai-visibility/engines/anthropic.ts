import {
  asArray,
  isRecord,
  ENGINE_REQUEST_TIMEOUT_MS,
} from "@/lib/ai-visibility/engines/shape";
import {
  classifyHttpFailure,
  engineFailure,
  logEngineFailure,
} from "@/lib/ai-visibility/engines/failure";
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

/**
 * Measured, not estimated: one live grounded call on 2026-08-23 returned
 * 18,111 input + 1,293 output tokens and issued 2 searches.
 *
 *   input   18,111 x $3/M   = $0.0543
 *   output   1,293 x $15/M  = $0.0194
 *   search       2 x $10/1k = $0.0200
 *                             -------
 *                             $0.0937
 *
 * At Sonnet 5's standard rates, deliberately not the $2/$10 introductory rates
 * that expire 2026-08-31 — a constant that quietly under-charges the moment an
 * intro period ends is the failure this replaced. The old $0.012 assumed "a
 * short answer"; grounded search puts the search RESULTS in the input, which is
 * where nearly all the money goes.
 */
export const ANTHROPIC_COST_PER_CALL_USD = 0.094;

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
    // See the note in `openai.ts`: a missing key and a rejected key have the
    // same remedy, and the decryption-failure state belongs to the keys table.
    return engineFailure("anthropic", "invalid_key", { detail: "no key configured" });
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
    // Transport, or the 60s abort. Nothing reached the model, so nothing was
    // billed and the next wave may well get through — see `EngineError.retryable`.
    //
    // `String(error)` stays out of the returned message: a fetch failure can
    // carry the request it failed on, and that request has an `x-api-key`
    // header. Scrubbed server log instead.
    console.error(`[ai-visibility] anthropic request failed:`, error);
    return engineFailure("anthropic", "provider_unavailable", {
      detail: "request never completed",
      retryable: true,
    });
  }

  // Body read for the log, then dropped. Anthropic's own error envelope is
  // comparatively tame, but its RESPONSE HEADERS carry
  // `anthropic-organization-id` — which is why only one named header is read
  // here and `logEngineFailure` takes the body text rather than the response.
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // Status AND body. Anthropic's spend-cap 429 is the case that forced this:
    // it carries no `retry-after` and is identified only by
    // `error.details.error_code === "enforced_spend_limit_reached"`. Its
    // out-of-credit case is a 400, which the status alone would call our bug.
    const failure = classifyHttpFailure("anthropic", response.status, body, response.headers);
    logEngineFailure("anthropic", response.status, failure.code, body);
    return engineFailure("anthropic", failure.code, {
      requestId: response.headers.get("request-id"),
      retryable: failure.retryable,
      retryAfterMs: failure.retryAfterMs,
    });
  }

  let raw: AnthropicResponse;
  try {
    raw = (await response.json()) as AnthropicResponse;
  } catch {
    return engineFailure("anthropic", "bad_response", { detail: "unparseable JSON" });
  }
  if (!isRecord(raw)) {
    return engineFailure("anthropic", "bad_response", { detail: "non-object body" });
  }

  // Every return below this point follows a complete, readable response, so the
  // call was billed whatever its verdict — see `EngineError.costUsd`.
  if (raw.stop_reason === "refusal") {
    return engineFailure("anthropic", "refused", { costUsd: ANTHROPIC_COST_PER_CALL_USD });
  }
  // A cut-off answer is not a measurement: a brand named in the tail that never
  // got written would score as absent, which is a false negative in the
  // headline number. `pause_turn` is the same story — the turn is unfinished.
  // Both become coverage gaps rather than quiet zeroes.
  if (raw.stop_reason === "max_tokens" || raw.stop_reason === "pause_turn") {
    return engineFailure("anthropic", "bad_response", {
      // A documented enum value, not prose.
      detail: `truncated answer: ${raw.stop_reason}`,
      costUsd: ANTHROPIC_COST_PER_CALL_USD,
    });
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
    return engineFailure("anthropic", "refused", {
      detail: "no answer text",
      costUsd: ANTHROPIC_COST_PER_CALL_USD,
    });
  }
  // An answer written from the model's own memory is a real answer — what the
  // engine SAID is measurable, only what it CITED is not. `search_used` carries
  // that distinction downstream; see the ungrounded-answers design.
  //
  // Citations hang off text blocks, independently of the `server_tool_use`
  // block that sets the flag, so a citation can arrive with `searchUsed` false.
  // Downstream `citationRate` divides by the grounded sample count, so that
  // combination would report over 100%. Citations are the stronger evidence.
  if (citations.length > 0) searchUsed = true;

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
