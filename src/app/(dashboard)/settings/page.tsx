import { eq } from "drizzle-orm";
import { db } from "@/db";
import { scheduleConfigs, tenants, systemPersonas } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { saveWorkspaceName, saveBrandProfile } from "./actions";
import { PersonasEditor } from "./personas-editor";
import { BrandStyleImport } from "./brand-style-import";
import { IndustrySelect } from "./industry-select";
import { ScheduleForm } from "./schedule-form";
import { ToastForm } from "./toast-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function SettingsPage() {
  const session = await requireSession();
  const brandProfile = await getOrCreateBrandProfile(session.user.tenantId);
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);
  const [workspaceSchedule] = await db
    .select()
    .from(scheduleConfigs)
    .where(eq(scheduleConfigs.tenantId, session.user.tenantId));
  const personaCatalog = await db
    .select({
      key: systemPersonas.key,
      name: systemPersonas.name,
      description: systemPersonas.description,
    })
    .from(systemPersonas)
    .orderBy(systemPersonas.sortOrder);

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

      <Card>
        <CardHeader>
          <CardTitle>Brand profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <BrandStyleImport defaultUrl={brandProfile.updatesPageUrl ?? ""} />
          <ToastForm action={saveBrandProfile} successMessage="Brand profile saved" className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tone">Tone</Label>
              <Textarea key={brandProfile.tone ?? ""} id="tone" name="tone" rows={3} defaultValue={brandProfile.tone ?? ""} />
            </div>
            <div className="space-y-2">
              <Label>Industry</Label>
              <IndustrySelect defaultValue={brandProfile.industry ?? ""} />
            </div>
            <div className="space-y-2">
              <Label>User personas</Label>
              <PersonasEditor personas={brandProfile.userPersonas} catalog={personaCatalog} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="doList">Do</Label>
              <Textarea
                key={brandProfile.doList.join("\n")}
                id="doList"
                name="doList"
                rows={3}
                placeholder="One per line"
                defaultValue={brandProfile.doList.join("\n")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dontList">Don&apos;t</Label>
              <Textarea
                key={brandProfile.dontList.join("\n")}
                id="dontList"
                name="dontList"
                rows={3}
                placeholder="One per line"
                defaultValue={brandProfile.dontList.join("\n")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="updatesStyleSummary">Updates page style summary</Label>
              <Textarea
                key={brandProfile.updatesStyleSummary ?? ""}
                id="updatesStyleSummary"
                name="updatesStyleSummary"
                rows={3}
                defaultValue={brandProfile.updatesStyleSummary ?? ""}
              />
            </div>
            <Button type="submit" variant="outline">
              Save
            </Button>
          </ToastForm>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Publishing schedule</CardTitle>
        </CardHeader>
        <CardContent>
          <ScheduleForm
            defaults={{
              cadence: workspaceSchedule?.cadence ?? "weekly",
              threshold: workspaceSchedule?.threshold ?? null,
              thresholdEnabled: workspaceSchedule?.thresholdEnabled ?? false,
              hour: workspaceSchedule?.hour ?? 9,
              dayOfWeek: workspaceSchedule?.dayOfWeek ?? null,
              dayOfMonth: workspaceSchedule?.dayOfMonth ?? null,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
