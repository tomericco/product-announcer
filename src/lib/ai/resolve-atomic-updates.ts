import { generateObject } from "ai";
import { z } from "zod";
import { resolveModel, modelId } from "./model";
import { recordLlmUsage } from "./llm-usage";

export const RESOLVER_BATCH_SIZE = 25;

export type ResolverEvent = {
  id: string;
  type: "commit" | "pull_request" | "task";
  title: string;
  summary: string | null;
  repoName: string | null;
};

export type OpenAtomicUpdate = { id: string; title: string; summary: string };

export type ResolutionAction =
  | { eventId: string; action: "assign"; atomicUpdateId: string }
  | {
      eventId: string;
      action: "create";
      title: string;
      summary: string;
      category: "new" | "improved" | "fixed";
    };

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ eventId: z.string(), action: z.literal("assign"), atomicUpdateId: z.string() }),
  z.object({
    eventId: z.string(),
    action: z.literal("create"),
    title: z.string(),
    summary: z.string(),
    category: z.enum(["new", "improved", "fixed"]),
  }),
]);

export const ResolutionSchema = z.object({ actions: z.array(ActionSchema) });

const RESOLVER_SYSTEM = [
  "You group code changes into atomic updates for a user-facing product changelog.",
  "An atomic update is ONE meaningful change a user would care about — a feature, or a fix.",
  "Several commits, a pull request, and a task can all describe the same atomic update.",
  "For each event, either assign it to an existing open atomic update if it describes the same change,",
  "or create a new atomic update if it does not.",
  "Prefer assigning over creating: a follow-up fix to work already in progress belongs to that atomic update.",
  "Several events in this batch may describe the same new change. In that case give every one of them",
  "a create action carrying the SAME title and summary — they will be merged into a single atomic update.",
  "Return exactly one action per event. Use only atomicUpdateId values from the provided list.",
  "Write title as a short noun phrase and summary as one plain sentence describing the user-visible benefit.",
].join(" ");

export function buildResolverPrompt(events: ResolverEvent[], open: OpenAtomicUpdate[]): string {
  const openBlock =
    open.length === 0
      ? "(none)"
      : open.map((a) => `- id: ${a.id}\n  title: ${a.title}\n  summary: ${a.summary}`).join("\n");

  const eventBlock = events
    .map((e) => {
      const where = e.repoName ? ` in ${e.repoName}` : "";
      const summary = e.summary ? `\n  summary: ${e.summary}` : "";
      return `- id: ${e.id}\n  type: ${e.type}${where ? `\n  repo:${where}` : ""}\n  title: ${e.title}${summary}`;
    })
    .join("\n");

  return `Open atomic updates:\n${openBlock}\n\nNew events to resolve:\n${eventBlock}`;
}

export async function resolveAtomicUpdates(input: {
  tenantId: string;
  events: ResolverEvent[];
  open: OpenAtomicUpdate[];
}): Promise<ResolutionAction[]> {
  if (input.events.length === 0) return [];

  try {
    const spec = process.env.RESOLVER_MODEL ?? "anthropic/claude-sonnet-4-5";
    const { object, usage } = await generateObject({
      model: resolveModel(spec),
      schema: ResolutionSchema,
      system: RESOLVER_SYSTEM,
      prompt: buildResolverPrompt(input.events, input.open),
    });

    await recordLlmUsage({
      tenantId: input.tenantId,
      operation: "resolution",
      model: modelId(spec),
      usage,
    });

    const eventIds = new Set(input.events.map((e) => e.id));
    const openIds = new Set(input.open.map((a) => a.id));

    // Guard against hallucinated ids: an action naming an event we did not send,
    // or an atomic update that does not exist, would corrupt the apply step.
    return object.actions.filter((a) => {
      if (!eventIds.has(a.eventId)) return false;
      if (a.action === "assign") return openIds.has(a.atomicUpdateId);
      return true;
    });
  } catch (error) {
    // Do NOT fail open. An empty plan leaves the events unassigned, which is a
    // visible, recoverable state; a fabricated plan is not.
    console.error("[resolve-atomic-updates] resolution failed:", error);
    return [];
  }
}
