import { guardOnboardingStep } from "../guard";
import { StepHeader } from "../steps";
import { bootstrapOnboardingCompany, importBrandStyle, skipBrandStep } from "../actions";
import { SubmitButton, SecondaryFormAction } from "../submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function BrandStepPage({
  searchParams,
}: {
  searchParams: Promise<{ bootstrap?: string; brandImport?: string; error?: string }>;
}) {
  await guardOnboardingStep(2);
  const { bootstrap, brandImport, error } = await searchParams;

  return (
    <div className="space-y-8">
      <StepHeader
        step={2}
        title="Your company"
        description="Paste your website and we'll draft a company profile — who you are, what makes you different, and who you're up against. Review and refine everything anytime under Company."
      />
      {/* Both buttons share ONE form so useFormStatus can disable the skip while
          a draft is in flight — a sibling form would report only its own state
          and stay clickable mid-draft. */}
      <form action={bootstrapOnboardingCompany} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="websiteUrl">Company website</Label>
          <Input
            id="websiteUrl"
            name="websiteUrl"
            type="url"
            placeholder="https://yourproduct.com"
            autoFocus
            required
          />
          {error === "empty" && <p className="text-destructive text-sm">Paste a URL, or skip this step</p>}
          {/* Muted, not destructive — and deliberately so. An empty URL above is a
              hard validation error the user must correct, so it gets `destructive`
              like the workspace-name step. A blocked site is an EXPECTED soft
              outcome with two offered exits (try another URL, or skip), and dressing
              a routine result in an alarming red banner trains people to ignore red.
              Don't "fix" this into destructive to match the line above. */}
          {bootstrap === "failed" && (
            <p className="text-muted-foreground text-sm">
              We couldn&apos;t read that site. Try another URL, or skip and fill in your company details under
              Company.
            </p>
          )}
        </div>
        <SubmitButton className="w-full" pendingLabel="Reading your site…">
          Continue
        </SubmitButton>
        <div className="flex justify-center">
          <SecondaryFormAction action={skipBrandStep} className="text-muted-foreground">
            Skip for now
          </SecondaryFormAction>
        </div>
      </form>

      {/* Kept as a secondary, separately-scoped action: importBrandStyle reads the
          updates page for voice, while the form above reads the company site for
          identity and positioning. A team may want both, so neither replaces the
          other. Its own <form> because it has its own required field
          (updatesPageUrl) — sharing the primary form would submit an empty
          websiteUrl on this path. */}
      <div className="space-y-3 border-t pt-6">
        <div className="space-y-1">
          <p className="text-sm font-medium">Import your brand voice</p>
          <p className="text-muted-foreground text-xs">
            Paste your changelog or &ldquo;what&apos;s new&rdquo; page and we&apos;ll learn how you write.
          </p>
        </div>
        <form action={importBrandStyle} className="space-y-3">
          <Label htmlFor="updatesPageUrl" className="sr-only">
            Updates page URL
          </Label>
          <Input
            id="updatesPageUrl"
            name="updatesPageUrl"
            type="url"
            placeholder="https://yourproduct.com/changelog"
            required
          />
          {brandImport === "failed" && (
            <p className="text-muted-foreground text-sm">We couldn&apos;t read that page. Try another URL.</p>
          )}
          <SubmitButton className="w-full" pendingLabel="Reading your page…">
            Import brand voice
          </SubmitButton>
        </form>
      </div>
    </div>
  );
}
