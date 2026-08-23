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
import { listPrompts, runnablePrompts } from "@/lib/ai-visibility/prompts";
import { capExceeded } from "@/lib/ai-visibility/cost";
import { engineCost } from "@/lib/ai-visibility/engines";
import { ENGINE_ORDER } from "../ai-visibility/engine-labels";
import type { EngineId } from "@/lib/ai-visibility/types";
import { ImagePolicyForm } from "./image-policy-form";
import { ToastForm } from "./toast-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function SettingsPage() {
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
  const aiVisibilitySpend = await capExceeded(
    session.user.tenantId,
    aiVisibilitySettings,
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
