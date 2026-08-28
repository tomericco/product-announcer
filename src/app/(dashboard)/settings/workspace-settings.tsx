import { eq } from "drizzle-orm";
import { db } from "@/db";
import { scheduleConfigs, tenants } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { listWorkspaceMembers } from "@/lib/workspace/members";
import { getActiveInvite } from "@/lib/workspace/invites";
import { saveWorkspaceName } from "./actions";
import { CalendarForm } from "./calendar-form";
import { MembersSection } from "./members-section";
import { ScheduleForm } from "./schedule-form";
import { AiVisibilityForm } from "./ai-visibility-form";
import { normalizeWeekStart } from "@/lib/workspace/calendar-settings";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { getAiVisibilitySettings } from "@/lib/ai-visibility/settings";
import { effectiveEngines, listEngineKeys } from "@/lib/ai-visibility/engine-keys";
import { listPrompts, runnablePrompts } from "@/lib/ai-visibility/prompts";
import { capExceeded } from "@/lib/ai-visibility/cost";
import { callsPerEnginePerRun } from "@/lib/ai-visibility/planned-calls";
import { engineCost } from "@/lib/ai-visibility/engines";
import { ENGINE_ORDER } from "../ai-visibility/engine-labels";
import type { EngineId } from "@/lib/ai-visibility/types";
import { AiEnginesCard, type EngineKeyRow } from "./ai-engines-card";
import { ImagePolicyForm } from "./image-policy-form";
import { ToastForm } from "./toast-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export async function WorkspaceSettings() {
  const session = await requireSession();
  const members = await listWorkspaceMembers(session.user.tenantId);
  const activeInvite = await getActiveInvite(session.user.tenantId);
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);
  const [workspaceSchedule] = await db
    .select()
    .from(scheduleConfigs)
    .where(eq(scheduleConfigs.tenantId, session.user.tenantId));
  const profile = await getOrCreateCompanyProfile(session.user.tenantId);
  const aiVisibilitySettings = await getAiVisibilitySettings(session.user.tenantId);
  // Sliced to what a run will actually ask, so the settings card's monthly
  // projection matches `capExceeded` and the planner. A tenant seeded under
  // the old 30-prompt ceiling still has 30 active rows; only the first
  // `MAX_ACTIVE_PROMPTS` of them are ever asked.
  const aiVisibilityPrompts = runnablePrompts(
    await listPrompts(session.user.tenantId, { status: "active" })
  );
  // Read here, in the Server Component, and handed down as plain numbers:
  // `engineCost` lives with the three fetch-based API clients, so importing it
  // from the form would pull all three into the browser bundle.
  const engineCosts = Object.fromEntries(
    ENGINE_ORDER.map((engine) => [engine, engineCost(engine)])
  ) as Record<EngineId, number>;

  // BYOK. `keys` drives the AI-engines card; `runEngines` is what the schedule
  // card prices and what `capExceeded` is asked about — `settings.engines`
  // intersected with the engines holding an enabled, verified key, with no
  // fallback when that is empty. Quoting a three-engine price to a tenant with
  // one key would be wrong on the one card whose job is to be right about money.
  const engineKeys = await listEngineKeys(session.user.tenantId);
  const runEngines = await effectiveEngines(
    session.user.tenantId,
    aiVisibilitySettings.engines
  );

  // What ONE run of the current prompt set costs per engine, for the card's
  // per-row line. The same split `capExceeded` charges — brand-check prompts are
  // sampled once whatever the samples setting says — so the two agree.
  const callsPerRunPerEngine = callsPerEnginePerRun(
    aiVisibilityPrompts.length,
    aiVisibilityPrompts.filter((prompt) => prompt.intent === "brand_check").length,
    aiVisibilitySettings.samplesPerPrompt
  );
  const engineRunCosts = Object.fromEntries(
    ENGINE_ORDER.map((engine) => [engine, engineCost(engine) * callsPerRunPerEngine])
  ) as Record<EngineId, number>;

  // Dates cross the client boundary as ISO strings: a `Date` in a Client
  // Component prop is serialised anyway, and typing it honestly is what stops a
  // formatter being written against a value that is really a string.
  const engineKeyRows: EngineKeyRow[] = engineKeys.map((row) => ({
    engine: row.engine,
    last4: row.last4,
    status: row.status,
    enabled: row.enabled,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdByName,
  }));

  const aiVisibilitySpend = await capExceeded(
    session.user.tenantId,
    { ...aiVisibilitySettings, engines: runEngines },
    new Date()
  );

  return (
    <div className="space-y-8">
      <Card>
        <CardHeader>
          <CardTitle>Workspace name</CardTitle>
        </CardHeader>
        <CardContent>
          <ToastForm action={saveWorkspaceName} successMessage="Workspace name saved" className="flex gap-2">
            <Input key={tenant?.name ?? ""} name="name" defaultValue={tenant?.name ?? ""} className="flex-1" />
            <Button type="submit" variant="outline">
              Save
            </Button>
          </ToastForm>
        </CardContent>
      </Card>

      <MembersSection
        members={members}
        isOwner={session.user.role === "owner"}
        hasActiveInvite={activeInvite !== null}
        workspaceId={session.user.tenantId}
        currentUserId={session.user.id}
      />

      <Card>
        <CardHeader>
          <CardTitle>Publishing schedule</CardTitle>
        </CardHeader>
        <CardContent>
          <ScheduleForm defaults={{ hour: workspaceSchedule?.hour ?? 9 }} />
        </CardContent>
      </Card>

      {/* Above the cadence and budget controls, per the design: the keys are
          what decide whether any of those settings do anything at all, so a
          tenant meeting this section for the first time meets the gate first. */}
      <Card id="ai-engines">
        <CardHeader>
          <CardTitle>AI engines</CardTitle>
        </CardHeader>
        <CardContent>
          <AiEnginesCard
            keys={engineKeyRows}
            costPerRun={engineRunCosts}
            costPerCall={engineCosts}
            isOwner={session.user.role === "owner"}
          />
        </CardContent>
      </Card>

      <Card id="ai-visibility">
        <CardHeader>
          <CardTitle>AI visibility</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Keyed on the server values like every other card on this page:
              the form seeds its state once. */}
          <AiVisibilityForm
            key={JSON.stringify(aiVisibilitySettings)}
            defaults={aiVisibilitySettings}
            engines={runEngines}
            promptCount={aiVisibilityPrompts.length}
            brandCheckCount={
              aiVisibilityPrompts.filter((prompt) => prompt.intent === "brand_check").length
            }
            costPerCall={engineCosts}
            spentUsd={aiVisibilitySpend.spentUsd}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Calendar</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Workspace-level, like every other card on this page: the week
              start and the holiday countries are properties of the shared
              calendar, not of whoever happens to be looking at it. */}
          <CalendarForm
            defaults={{
              weekStartsOn: normalizeWeekStart(tenant?.weekStartsOn),
              holidayCountries: tenant?.holidayCountries ?? [],
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Content images</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Keyed on the server value like the other cards: the form seeds
              its matrix once from `initial`. */}
          <ImagePolicyForm key={JSON.stringify(profile.imagePolicy)} initial={profile.imagePolicy} />
        </CardContent>
      </Card>
    </div>
  );
}
