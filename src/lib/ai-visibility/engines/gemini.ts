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

export const GEMINI_LABEL = "Gemini API, grounded";

/**
 * NOT VERIFIED LIVE — there is no GEMINI_API_KEY in this deployment, so this
 * comes from Google's published catalogue rather than from a call that worked.
 *
 * What it replaces was worse than stale: `gemini-3-pro` was never a catalogue
 * id at all, so every Gemini call would have 404'd and the engine would have
 * reported a permanent coverage gap. `gemini-3-pro-preview` did exist and was
 * shut down on 2026-03-09.
 *
 * `gemini-3.7-flash` is GA rather than preview, is listed as grounding-capable,
 * and is the model in Google's own `generateContent` grounding example. GA
 * matters more than tier here: a preview id can be withdrawn on ~3 months'
 * notice, which is exactly what killed the last one, and a weekly run that
 * quietly 404s for a fortnight is indistinguishable from an engine that stopped
 * mentioning the tenant.
 */
export const GEMINI_DEFAULT_MODEL = "gemini-3.7-flash";

/**
 * $14 per 1,000 grounded prompts at list price.
 *
 * The first 5,000 grounded prompts a month are free, which makes Gemini the
 * cheapest engine in practice — but the free tier is per Google project, not
 * per tenant, so budgeting at list price is the only per-tenant estimate that
 * cannot under-count.
 */
/**
 * DERIVED, not measured — no Gemini key was available, so this assumes a call
 * shaped like the two that were measured (~20k input, ~1.5k output, 2 queries):
 *
 *   input   20,000 x $1.50/M = $0.0300
 *   output   1,500 x $7.50/M = $0.0113
 *   search       2 x $14/1k  = $0.0280
 *                              -------
 *                              $0.0693
 *
 * At standard rates rather than the $0.75/$3.75 introductory ones that expire
 * 2026-12-31, for the reason the Anthropic constant gives. Grounding bills per
 * SEARCH QUERY, not per request, so a request that searches three times costs
 * three times the grounding. The first 5,000 grounded prompts a month are free
 * PER GOOGLE PROJECT — deliberately not modelled here, because that allowance
 * is shared across every tenant and would make a per-call constant lie for all
 * but the first.
 *
 * Re-measure once a key exists.
 */
export const GEMINI_COST_PER_CALL_USD = 0.069;

const GEMINI_MODELS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

type GeminiGroundingChunk = { web?: { uri?: string; title?: string } };
type GeminiPart = { text?: string; thoughtSignature?: string };
type GeminiCandidate = {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
  groundingMetadata?: {
    groundingChunks?: GeminiGroundingChunk[];
    webSearchQueries?: string[];
    /** HTML+CSS for the Search Suggestions widget. Large, and useless to us. */
    searchEntryPoint?: unknown;
  };
};
type GeminiResponse = { modelVersion?: string; candidates?: GeminiCandidate[] };

/**
 * A copy of the response without the two heavyweight fields.
 *
 * `searchEntryPoint.renderedContent` is a block of HTML+CSS for Google's
 * "Search Suggestions" chip widget — required to be DISPLAYED by anyone
 * rendering grounded output, and worthless to a stored evidence record, which
 * renders nothing. `thoughtSignature` on a part is an opaque continuation blob
 * of the same family as the OpenAI and Anthropic ones. Both are deleted only
 * when present, so a response without them is returned untouched.
 *
 * Unverified like the rest of this client's shape: no key, no live call. The
 * deletes are safe either way — a field that is not there is not removed.
 */
function sanitizeRaw(raw: GeminiResponse): GeminiResponse {
  if (!Array.isArray(raw.candidates)) return raw;
  return {
    ...raw,
    candidates: raw.candidates.map((candidate) => {
      if (!isRecord(candidate)) return candidate;
      const copy: GeminiCandidate = { ...candidate };

      if (isRecord(copy.content) && Array.isArray(copy.content.parts)) {
        copy.content = {
          ...copy.content,
          parts: copy.content.parts.map((part) => {
            if (!isRecord(part) || part.thoughtSignature === undefined) return part;
            const trimmed = { ...part };
            delete trimmed.thoughtSignature;
            return trimmed;
          }),
        };
      }

      if (isRecord(copy.groundingMetadata) && copy.groundingMetadata.searchEntryPoint) {
        const grounding = { ...copy.groundingMetadata };
        delete grounding.searchEntryPoint;
        copy.groundingMetadata = grounding;
      }

      return copy;
    }),
  };
}

export async function askGemini(
  prompt: string,
  deps: { fetchImpl?: typeof fetch } = {}
): Promise<EngineAnswer | EngineError> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    return { kind: "error", message: "GEMINI_API_KEY is not set" };
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const model = process.env.AI_VISIBILITY_GEMINI_MODEL ?? GEMINI_DEFAULT_MODEL;

  let response: Response;
  try {
    response = await fetchImpl(`${GEMINI_MODELS_ENDPOINT}/${model}:generateContent`, {
      // Bounded, because the run slice's wall-clock budget is otherwise
      // advisory: a provider that accepts the connection and then never
      // answers holds a whole concurrency wave open past the budget, past the
      // sweep's deadline, and into the platform's own timeout — which kills
      // the invocation instead of recording an error. A timeout here becomes an
      // ordinary EngineError on one sample.
      signal: AbortSignal.timeout(ENGINE_REQUEST_TIMEOUT_MS),
      method: "POST",
      // Header rather than `?key=`: the key must not end up in a URL, in a
      // log line or in an error message.
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        ...(engineSystemPrompt() ? { systemInstruction: { parts: [{ text: engineSystemPrompt() }] } } : {}),
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
      }),
    });
  } catch (error) {
    return { kind: "error", message: `gemini request failed: ${String(error)}` };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { kind: "error", message: `gemini ${response.status}: ${body.slice(0, 300)}` };
  }

  let raw: GeminiResponse;
  try {
    raw = (await response.json()) as GeminiResponse;
  } catch (error) {
    return { kind: "error", message: `gemini returned unparseable JSON: ${String(error)}` };
  }
  if (!isRecord(raw)) {
    return { kind: "error", message: "gemini returned a non-object body" };
  }

  const candidate = asArray<GeminiCandidate>(raw.candidates)[0];
  if (!isRecord(candidate)) {
    return { kind: "refused", message: "gemini returned no candidate" };
  }

  // Same rule as the other engines: an answer that stopped because it ran out
  // of room is not a measurement, because a brand named in the tail it never
  // wrote would score as absent. `STOP` is the clean finish; an absent
  // finishReason is treated as fine, since the text check below still applies.
  // Every verdict from here on follows a complete, readable response, so the
  // call was billed whatever it says — see `EngineError.costUsd`.
  if (candidate.finishReason === "MAX_TOKENS") {
    return {
      kind: "error",
      message: "gemini answer incomplete: MAX_TOKENS",
      costUsd: GEMINI_COST_PER_CALL_USD,
    };
  }

  const text = asArray<GeminiPart>(candidate.content?.parts)
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
  if (text.trim().length === 0) {
    return {
      kind: "refused",
      message: `gemini returned no answer text (finishReason: ${candidate.finishReason ?? "unknown"})`,
      costUsd: GEMINI_COST_PER_CALL_USD,
    };
  }

  const grounding = candidate.groundingMetadata;
  const searchQueries = asArray<string>(grounding?.webSearchQueries).filter(
    (query): query is string => typeof query === "string" && query.length > 0
  );

  const citations: EngineCitation[] = [];
  const seen = new Set<string>();
  for (const chunk of asArray<GeminiGroundingChunk>(grounding?.groundingChunks)) {
    if (!isRecord(chunk)) continue;
    const uri = chunk.web?.uri;
    if (typeof uri !== "string" || uri.length === 0 || seen.has(uri)) continue;
    seen.add(uri);
    // Stored EXACTLY as Gemini returned it. These are
    // `vertexaisearch.cloud.google.com` handles that 302 to the real page;
    // `domains.resolveRedirect` follows them at extraction time, so the raw
    // response stays a faithful record of what the API said.
    citations.push({ url: uri, position: citations.length + 1 });
  }

  // Gemini decides PER QUESTION whether to ground, and declines on exactly the
  // discovery, alternatives and how-to prompts this feature exists to measure.
  // An ungrounded answer is still what a buyer asking that question reads, so
  // it is a successful sample carrying `searchUsed: false`; the citation-family
  // metrics exclude it downstream. See the ungrounded-answers design.
  const searchUsed = searchQueries.length > 0 || citations.length > 0;

  return {
    text,
    // `modelVersion` is the resolved, dated id — the whole point of recording
    // it, since a jump in the numbers after a silent model swap must be
    // annotated rather than briefed.
    modelId: raw.modelVersion ?? model,
    citations,
    searchUsed,
    searchQueries,
    raw: sanitizeRaw(raw),
    costUsd: GEMINI_COST_PER_CALL_USD,
  };
}

export const geminiEngine: EngineClient = { id: "gemini", label: GEMINI_LABEL, ask: askGemini };
