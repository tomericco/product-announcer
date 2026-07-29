import { db } from "@/db";
import { systemPersonas } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { saveBrandProfile } from "./actions";
import { BrandStyleImport } from "./brand-style-import";
import { IndustrySelect } from "./industry-select";
import { PersonasEditor } from "./personas-editor";
import { GuidelinesEditor } from "./guidelines-editor";
import { ToastForm } from "../settings/toast-form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export default async function BrandGuidelinesPage() {
  const session = await requireSession();
  const brandProfile = await getOrCreateBrandProfile(session.user.tenantId);
  const personaCatalog = await db
    .select({
      key: systemPersonas.key,
      name: systemPersonas.name,
      description: systemPersonas.description,
    })
    .from(systemPersonas)
    .orderBy(systemPersonas.sortOrder);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Brand guidelines</h1>
        <p className="text-sm text-muted-foreground">
          How your product updates should be written. Every draft is generated and reviewed against this.
        </p>
      </div>

      <BrandStyleImport defaultUrl={brandProfile.updatesPageUrl ?? ""} />

      <ToastForm action={saveBrandProfile} successMessage="Brand guidelines saved" className="space-y-6">
        <div className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Industry</Label>
            <IndustrySelect defaultValue={brandProfile.industry ?? ""} />
          </div>
          <div className="space-y-2">
            <Label>User personas</Label>
            <PersonasEditor personas={brandProfile.userPersonas} catalog={personaCatalog} />
          </div>
        </div>

        <GuidelinesEditor defaultValue={brandProfile.guidelines} />

        <Button type="submit" variant="outline">
          Save
        </Button>
      </ToastForm>
    </div>
  );
}
