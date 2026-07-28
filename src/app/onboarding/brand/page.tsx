import { guardOnboardingStep } from "../guard";
import { StepHeader } from "../steps";
import { importBrandStyle, skipBrandStep } from "../actions";
import { SubmitButton, SecondaryFormAction } from "../submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function BrandStepPage({
  searchParams,
}: {
  searchParams: Promise<{ brandImport?: string }>;
}) {
  await guardOnboardingStep(2);
  const { brandImport } = await searchParams;

  return (
    <div className="space-y-8">
      <StepHeader
        step={2}
        title="Import your brand style"
        description="Paste your existing changelog or “what’s new” page and we’ll learn how you write. Refine it anytime in Settings."
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
          {brandImport === "failed" && (
            <p className="text-muted-foreground text-sm">
              We couldn&apos;t read that page. Try another URL, or skip and set your brand style in Settings.
            </p>
          )}
        </div>
        <SubmitButton className="w-full" pendingLabel="Reading your page…">
          Import and continue
        </SubmitButton>
        <SecondaryFormAction action={skipBrandStep} className="text-muted-foreground w-full">
          Skip for now
        </SecondaryFormAction>
      </form>
    </div>
  );
}
