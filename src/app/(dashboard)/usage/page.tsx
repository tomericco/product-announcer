import { UsageSettings } from "./usage-settings";

/**
 * An async Server Component with no props: same reasoning as the AI
 * visibility page — it needs neither `params` nor `searchParams`, and
 * `UsageSettings` (via `requireSession()`) is what keeps it dynamic.
 */
export default async function UsagePage() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        {/* The only font-heading on this page, matching ai-visibility/page.tsx. */}
        <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">AI usage</h1>
        <p className="text-muted-foreground text-sm">
          Credits used by AI features, and what AI-visibility sweeps spend on your own keys.
        </p>
      </div>
      <UsageSettings />
    </div>
  );
}
