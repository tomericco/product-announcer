import type { EngineId } from "@/lib/ai-visibility/types";
import type { EngineKeyStatus } from "@/lib/ai-visibility/engine-keys";

/**
 * Failure copy for a stored key, in a module BOTH sides of the client boundary
 * can import.
 *
 * Not in `engine-key-actions.ts`, which is `"use server"` — every export from
 * such a file must be an async Server Action, and a plain string function
 * exported from one is a build error. Not in `engines/failure.ts` either: that
 * module's sentences describe a CALL that failed inside a run ("the next run
 * tries again"), and these describe a stored CREDENTIAL a person is looking at
 * right now, with a Re-check button on screen to point them at. Same six
 * states, two different rooms.
 *
 * This module imports nothing but types, so the card can render it in the
 * browser without dragging the three fetch-based API clients into the bundle.
 */

/**
 * The sentence a human reads per failure state — design Decision 4's table.
 *
 * Four states, never three. LibreChat ships all four distinctly; Dify conflates
 * two into "check that your API key has not expired and has sufficient quota",
 * which tells a marketer to check two things and fix neither. The shape is
 * Zed's: name the provider, name the cause, name the next action, name the
 * screen.
 *
 * `unreadable` is the fifth, and the one most easily lost: it means WE could
 * not decrypt a key we hold. Zed shipped that inside its "invalid or has
 * expired" banner and sent users to replace keys that were fine.
 */
const ENGINE_VOICE: Record<EngineId, { product: string; provider: string; prefix: string; billing: string }> = {
  openai: {
    product: "ChatGPT",
    provider: "OpenAI",
    prefix: "sk-",
    billing: "platform.openai.com/settings/billing",
  },
  gemini: {
    product: "Gemini",
    provider: "Google",
    prefix: "AIza",
    billing: "aistudio.google.com/apikey",
  },
  anthropic: {
    product: "Claude",
    provider: "Anthropic",
    prefix: "sk-ant-",
    billing: "console.anthropic.com/settings/billing",
  },
};

export function engineKeyMessage(engine: EngineId, status: EngineKeyStatus): string {
  const voice = ENGINE_VOICE[engine];
  switch (status) {
    case "verified":
      return `${voice.product} is connected.`;
    case "invalid_key":
      return `${voice.product} rejected this key. Check you copied the whole thing, and that it's a secret key (starts \`${voice.prefix}\`) rather than an organization ID.`;
    case "quota_exceeded":
      return `That key is valid, but the ${voice.provider} account behind it has no credit. Add a payment method at ${voice.billing} and top up about $10, then paste the key again.`;
    case "rate_limited":
      return `${voice.provider} is rate-limiting this key — the account is on a new-account tier with low throughput. Wait a few minutes and try Re-check.`;
    case "provider_unavailable":
      return `Couldn't reach ${voice.provider} just now. This is usually temporary — try Re-check in a few minutes.`;
    case "unreadable":
      return `We couldn't read this workspace's stored ${voice.product} key. That's a fault on our side, not with your key — paste it again to replace it.`;
  }
}
