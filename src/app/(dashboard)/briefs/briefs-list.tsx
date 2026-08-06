import type { BriefWithSignals } from "@/lib/briefs/query";
import { BriefCard } from "./brief-card";

/**
 * The inbox's list of cards. `rows` already arrives ordered by score then
 * recency from `listBriefs` — this never reorders them, matching
 * `SignalsList`'s contract with `listSignals`.
 */
export function BriefsList({ briefs }: { briefs: BriefWithSignals[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {briefs.map((brief) => (
        <li key={brief.id}>
          <BriefCard brief={brief} />
        </li>
      ))}
    </ul>
  );
}
