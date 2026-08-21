import {
  NEUTRAL_SYSTEM_PROMPT,
  type EngineAnswer,
  type EngineCitation,
  type EngineClient,
  type EngineError,
} from "@/lib/ai-visibility/types";

export const GEMINI_LABEL = "Gemini API, grounded";
export const GEMINI_DEFAULT_MODEL = "gemini-3-pro";

/**
 * $14 per 1,000 grounded prompts at list price.
 *
 * The first 5,000 grounded prompts a month are free, which makes Gemini the
 * cheapest engine in practice — but the free tier is per Google project, not
 * per tenant, so budgeting at list price is the only per-tenant estimate that
 * cannot under-count.
 */
export const GEMINI_COST_PER_CALL_USD = 0.014;

const GEMINI_MODELS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

type GeminiGroundingChunk = { web?: { uri?: string; title?: string } };
type GeminiCandidate = {
  content?: { parts?: { text?: string }[] };
  finishReason?: string;
  groundingMetadata?: { groundingChunks?: GeminiGroundingChunk[]; webSearchQueries?: string[] };
};
type GeminiResponse = { modelVersion?: string; candidates?: GeminiCandidate[] };

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
      method: "POST",
      // Header rather than `?key=`: the key must not end up in a URL, in a
      // log line or in an error message.
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: NEUTRAL_SYSTEM_PROMPT }] },
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

  const candidate = raw.candidates?.[0];
  if (!candidate) return { kind: "refused", message: "gemini returned no candidate" };

  const text = (candidate.content?.parts ?? []).map((part) => part.text ?? "").join("");
  if (text.trim().length === 0) {
    return {
      kind: "refused",
      message: `gemini returned no answer text (finishReason: ${candidate.finishReason ?? "unknown"})`,
    };
  }

  const grounding = candidate.groundingMetadata;
  const searchQueries = (grounding?.webSearchQueries ?? []).filter(
    (query): query is string => typeof query === "string" && query.length > 0
  );

  const citations: EngineCitation[] = [];
  const seen = new Set<string>();
  for (const chunk of grounding?.groundingChunks ?? []) {
    const uri = chunk.web?.uri;
    if (typeof uri !== "string" || uri.length === 0 || seen.has(uri)) continue;
    seen.add(uri);
    // Stored EXACTLY as Gemini returned it. These are
    // `vertexaisearch.cloud.google.com` handles that 302 to the real page;
    // `domains.resolveRedirect` follows them at extraction time, so the raw
    // response stays a faithful record of what the API said.
    citations.push({ url: uri, position: citations.length + 1 });
  }

  const searchUsed = searchQueries.length > 0 || citations.length > 0;
  if (!searchUsed) {
    return { kind: "refused", message: "gemini answered without grounding the answer in a search" };
  }

  return {
    text,
    // `modelVersion` is the resolved, dated id — the whole point of recording
    // it, since a jump in the numbers after a silent model swap must be
    // annotated rather than briefed.
    modelId: raw.modelVersion ?? model,
    citations,
    searchUsed,
    searchQueries,
    raw,
    costUsd: GEMINI_COST_PER_CALL_USD,
  };
}

export const geminiEngine: EngineClient = { id: "gemini", label: GEMINI_LABEL, ask: askGemini };
