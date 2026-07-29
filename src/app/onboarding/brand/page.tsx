import { guardOnboardingStep } from "../guard";
import { StepHeader } from "../steps";
import { importBrandStyle, skipBrandStep } from "../actions";
import { SubmitButton, SecondaryFormAction } from "../submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function BrandStepPage({
  searchParams,
}: {
  searchParams: Promise<{ brandImport?: string; error?: string }>;
}) {
  await guardOnboardingStep(2);
  const { brandImport, error } = await searchParams;

  return (
    <div className="space-y-8">
      <StepHeader
        step={2}
        title="Import your brand style"
        description="Paste your existing changelog or “what’s new” page and we’ll learn how you write. Refine it anytime under Brand guidelines."
      />
      {/* Both buttons share ONE form so useFormStatus can disable the skip while
          an import is in flight — a sibling form would report only its own state
          and stay clickable mid-import. */}
      <form action={importBrandStyle} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="updatesPageUrl">Updates page URL</Label>
          <Input
            id="updatesPageUrl"
            name="updatesPageUrl"
            type="url"
            placeholder="https://yourproduct.com/changelog"
            autoFocus
            required
          />
          {error === "empty" && <p className="text-destructive text-sm">Paste a URL, or skip this step</p>}
          {/* Muted, not destructive — and deliberately so. An empty URL above is a
              hard validation error the user must correct, so it gets `destructive`
              like the workspace-name step. An unscrapable page is an EXPECTED soft
              outcome with two offered exits (try another URL, or skip), and dressing
              a routine result in an alarming red banner trains people to ignore red.
              Don't "fix" this into destructive to match the line above. */}
          {brandImport === "failed" && (
            <p className="text-muted-foreground text-sm">
              We couldn&apos;t read that page. Try another URL, or skip and write your guidelines under Brand
              guidelines.
            </p>
          )}
        </div>
        <SubmitButton className="w-full" pendingLabel="Reading your page…">
          Import and continue
        </SubmitButton>
        <div className="flex justify-center">
          <SecondaryFormAction action={skipBrandStep} className="text-muted-foreground">
            Skip for now
          </SecondaryFormAction>
        </div>
      </form>
    </div>
  );
}
