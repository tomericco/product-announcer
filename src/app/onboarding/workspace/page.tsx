import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tenants } from "@/db/schema";
import { guardOnboardingStep } from "../guard";
import { StepHeader } from "../steps";
import { saveWorkspaceName } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function WorkspaceStepPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await guardOnboardingStep(1);
  const { error } = await searchParams;
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);

  return (
    <div className="space-y-8">
      <StepHeader
        step={1}
        title="Name your workspace"
        description="This is how your team will see it. You can change it later in Settings."
      />
      <form action={saveWorkspaceName} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Workspace name</Label>
          <Input id="name" name="name" defaultValue={tenant?.name ?? ""} autoFocus required />
          {error === "empty" && <p className="text-destructive text-sm">Give your workspace a name to continue.</p>}
        </div>
        <Button type="submit" className="w-full">
          Continue
        </Button>
      </form>
    </div>
  );
}
