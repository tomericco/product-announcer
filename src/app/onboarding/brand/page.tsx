import Link from "next/link";
import { guardOnboardingStep } from "../guard";
import { StepHeader } from "../steps";
import { bootstrapOnboardingCompany, importBrandStyle, saveOnboardingCompany, skipBrandStep } from "../actions";
import { SubmitButton, SecondaryFormAction } from "../submit-button";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { listCompetitors } from "@/lib/workspace/competitors";
import { removeCompetitorAction } from "@/app/(dashboard)/company/actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

export default async function BrandStepPage({
  searchParams,
}: {
  searchParams: Promise<{ bootstrap?: string; brandImport?: string; error?: string; drafted?: string }>;
}) {
  const session = await guardOnboardingStep(2);
  const { bootstrap, brandImport, error, drafted } = await searchParams;

  // Detected from the profile itself, not trusted from `?drafted=1` alone: a
  // reload of this URL (or coming back via Back) must still show the review,
  // not drop the user back to a blank form. bootstrapCompanyContext always
  // sets websiteUrl on a successful crawl, so its presence IS "drafted."
  const profile = await getOrCreateCompanyProfile(session.user.tenantId);
  const showReview = Boolean(profile.websiteUrl);
  const proposedCompetitors = showReview ? await listCompetitors(session.user.tenantId) : [];

  // Keys the review form on the same tuple of drafted values company/page.tsx's
  // CompanyContextForm is keyed on (see the comment there for the full
  // rationale): bootstrapOnboardingCompany writes new columns and redirects
  // back to THIS SAME route on every re-draft — a soft navigation, so without
  // this key React reconciles the same <form> in place and its uncontrolled
  // `defaultValue` inputs keep showing the previous draft even though `profile`
  // above (and the database) now holds the new one. saveOnboardingCompany would
  // then persist what's on screen: the stale draft, not the fresh one.
  const draftKey = [
    profile.websiteUrl,
    profile.oneLiner,
    profile.category,
    profile.positioning,
    profile.topics.join(","),
  ].join("|");

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
            defaultValue={profile.websiteUrl ?? ""}
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
              Don't "fix" this into destructive to match the line above.

              Two different failure kinds share this slot, and they get different
              advice: `bootstrap` carries bootstrapCompanyContext's actual `reason`
              (a PageError like "blocked", or "analysis-empty"), not a flat "failed".
              A PageError means the site itself didn't come through, so "try another
              URL" is right. "analysis-empty" means the site read FINE but the model
              derived nothing usable from it — a different URL won't help there, so
              it gets its own message instead of the misleading one below. */}
          {bootstrap === "analysis-empty" ? (
            <p className="text-muted-foreground text-sm">
              We read your site, but couldn&apos;t draft anything useful from it. Fill in your company details under
              Company instead, or skip for now.
            </p>
          ) : (
            bootstrap && (
              <p className="text-muted-foreground text-sm">
                We couldn&apos;t read that site. Try another URL, or skip and fill in your company details under
                Company.
              </p>
            )
          )}
        </div>
        <SubmitButton className="w-full" pendingLabel="Reading your site…">
          {/* Distinct from the review form's own "Continue" below -- that one
              saves and advances; this one re-runs a paid crawl and overwrites
              the draft in place without advancing. Identical labels would make
              two very different actions look like the same one. */}
          {showReview ? "Re-draft from this URL" : "Draft my profile"}
        </SubmitButton>
        <div className="flex justify-center">
          <SecondaryFormAction action={skipBrandStep} className="text-muted-foreground">
            Skip for now
          </SecondaryFormAction>
        </div>
      </form>

      {/* Phase 2: only once bootstrapCompanyContext has actually drafted
          something. This is a review, not a formality -- the company profile is
          the ranking function every later agent scores incoming signals
          against, and the people least likely to ever open Company are exactly
          the ones whose site crawled poorly, so this is their only real chance
          to catch a bad draft. saveOnboardingCompany (not
          bootstrapOnboardingCompany) is what advances from here, because
          re-running the bootstrap to "save" would re-crawl and silently
          overwrite whatever gets corrected below. */}
      {showReview && (
        <div className="space-y-4 border-t pt-6">
          <div className="space-y-1">
            {drafted === "1" && <p className="text-sm font-medium">Here&apos;s what we drafted from your site.</p>}
            <p className="text-muted-foreground text-xs">
              Check this over before continuing — it&apos;s what every future update gets scored against.
            </p>
          </div>
          <form key={draftKey} action={saveOnboardingCompany} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="oneLiner">One-liner</Label>
              <Input
                id="oneLiner"
                name="oneLiner"
                defaultValue={profile.oneLiner ?? ""}
                placeholder="Issue tracking for software teams."
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="category">Market category</Label>
              <Input
                id="category"
                name="category"
                defaultValue={profile.category ?? ""}
                placeholder="Project management software"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="positioning">Positioning</Label>
              <Textarea
                id="positioning"
                name="positioning"
                rows={3}
                defaultValue={profile.positioning ?? ""}
                placeholder="Differentiators and the messages you want to own."
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="topics">Topics</Label>
              <Textarea
                id="topics"
                name="topics"
                rows={3}
                defaultValue={profile.topics.join(", ")}
                placeholder={"ai agents, developer tools\nobservability"}
              />
              <p className="text-muted-foreground text-xs">Comma- or newline-separated.</p>
            </div>

            {proposedCompetitors.length > 0 && (
              <div className="space-y-2">
                <Label>Competitors</Label>
                <ul className="space-y-2">
                  {proposedCompetitors.map((competitor) => (
                    <li
                      key={competitor.id}
                      className="flex items-center justify-between gap-2 rounded-md border p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{competitor.name}</p>
                        {competitor.websiteUrl && (
                          <p className="truncate text-xs text-muted-foreground">{competitor.websiteUrl}</p>
                        )}
                      </div>
                      {/* formAction overrides just this button's submission to a
                          DIFFERENT action than the form's own (saveOnboardingCompany)
                          — the same mechanism SecondaryFormAction uses above, so
                          removing one doesn't submit (and doesn't need) the rest of
                          this form's fields. formNoValidate for the same reason: the
                          required fields above must not block a removal. */}
                      <Button
                        type="submit"
                        formAction={removeCompetitorAction.bind(null, competitor.id)}
                        formNoValidate
                        variant="ghost"
                        size="sm"
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground text-xs">
                  Only removal happens here — add more competitors later under{" "}
                  <Link href="/company" className="underline">
                    Company
                  </Link>
                  .
                </p>
              </div>
            )}

            <SubmitButton className="w-full" pendingLabel="Saving…">
              Continue
            </SubmitButton>
          </form>
        </div>
      )}

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
