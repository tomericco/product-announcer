import { db } from "@/db";
import { systemPersonas } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getOrCreateBrandProfile } from "@/lib/workspace/brand-profile";
import { saveGuidelines } from "./actions";
import { BrandStyleImport } from "./brand-style-import";
import { IndustrySelect } from "./industry-select";
import { PersonasEditor } from "./personas-editor";
import { GuidelinesEditor } from "./guidelines-editor";
import { ToastForm } from "../settings/toast-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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
        <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">Brand guidelines</h1>
        <p className="text-sm text-muted-foreground">
          How your product updates should be written. Every draft is generated and reviewed against this.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Derive from your updates page</CardTitle>
        </CardHeader>
        <CardContent>
          <BrandStyleImport defaultUrl={brandProfile.updatesPageUrl ?? ""} />
        </CardContent>
      </Card>

      {/* Each card owns its own save: industry and persona add/remove write on
          click, a custom persona has a Save inside it, and the guidelines
          document has the form below. There is deliberately no page-level Save. */}
      <Card>
        <CardHeader>
          <CardTitle>Industry</CardTitle>
          <CardDescription>Grounds updates in the language of your market.</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Keyed on the server value. A successful import (BrandStyleImport,
              above) overwrites `industry` server-side and calls router.refresh(),
              which re-renders this page with the new brandProfile. IndustrySelect
              owns its selection as internal state, so without a key React would
              keep the existing instance and the new defaultValue would be
              silently ignored -- see the matching comment on GuidelinesEditor
              below for the full trade-off this accepts. */}
          <IndustrySelect key={brandProfile.industry ?? ""} defaultValue={brandProfile.industry ?? ""} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>User personas</CardTitle>
          <CardDescription>Who each update is written for, and what they care about.</CardDescription>
        </CardHeader>
        <CardContent>
          <PersonasEditor personas={brandProfile.userPersonas} catalog={personaCatalog} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Guidelines</CardTitle>
          <CardDescription>
            Voice, structure, and the words you do and don&apos;t use. Written as Markdown.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ToastForm action={saveGuidelines} successMessage="Brand guidelines saved" className="space-y-4">
            {/* Keyed on the server value for the same reason as IndustrySelect above:
                a successful import overwrites `guidelines` and refreshes the page, but
                GuidelinesEditor seeds its own useState once and otherwise never looks
                at `defaultValue` again -- without a key here, the editor would keep
                showing the pre-import text, and the next Save would write that stale
                text back over the freshly-imported guidelines. Trade-off accepted: this
                key also changes after an ordinary Save (the server value changes too),
                remounting the editor and losing cursor position and undo history. Worse
                would be silently discarding an import, and this mirrors the pattern the
                replaced Settings card used (`key={brandProfile.tone ?? ""}` etc). */}
            <GuidelinesEditor key={brandProfile.guidelines ?? ""} defaultValue={brandProfile.guidelines} />

            <Button type="submit" variant="outline">
              Save
            </Button>
          </ToastForm>
        </CardContent>
      </Card>
    </div>
  );
}
