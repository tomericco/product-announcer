import { eq } from "drizzle-orm";
import { db } from "@/db";
import { scheduleConfigs, tenants } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { listWorkspaceMembers } from "@/lib/workspace/members";
import { getActiveInvite } from "@/lib/workspace/invites";
import { saveWorkspaceName } from "./actions";
import { MembersSection } from "./members-section";
import { ScheduleForm } from "./schedule-form";
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
    </div>
  );
}
