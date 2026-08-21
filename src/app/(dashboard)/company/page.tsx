import { db } from "@/db";
import { systemPersonas, type Source } from "@/db/schema";
import { requireSession } from "@/lib/workspace/session";
import { getOrCreateCompanyProfile } from "@/lib/workspace/company-profile";
import { listCompetitors } from "@/lib/workspace/competitors";
import { listCompetitorSources, getNewsSource } from "@/lib/signals/sources";
import { ensureAiVisibilitySource } from "@/lib/ai-visibility/settings";
import { listPrompts } from "@/lib/ai-visibility/prompts";
import { saveGuidelines } from "./actions";
import { BrandStyleImport } from "./brand-style-import";
import { CompanyContextForm } from "./company-context-form";
import { CompetitorsEditor } from "./competitors-editor";
import { IndustrySelect } from "./industry-select";
import { NewsToggle } from "./news-toggle";
import { AiVisibilityCard } from "./ai-visibility-card";
import { PersonasEditor } from "./personas-editor";
import { GuidelinesEditor } from "./guidelines-editor";
import { VisualIdentityEditor } from "./visual-identity-editor";
import { ChangeEventsSection } from "./change-events-section";
import { AtomicUpdatesSection } from "./atomic-updates-section";
import { ToastForm } from "../settings/toast-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Reading `searchParams` (a Next.js 16 async Server Component prop, per
 * `node_modules/next/dist/docs/01-app/01-getting-started/03-layouts-and-pages.md`)
 * opts this page into dynamic rendering, which both new sections below rely
 * on: `ChangeEventsSection`/`AtomicUpdatesSection` filter on it, and their
 * client-side filter bars (`ChangeEventsFilters`/`AtomicUpdatesFilters`) call
 * `useSearchParams()`, which needs the route to already be dynamic rather
 * than statically prerendered.
 */
export default async function CompanyPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const session = await requireSession();
  const brandProfile = await getOrCreateCompanyProfile(session.user.tenantId);
  const competitors = await listCompetitors(session.user.tenantId);
  const competitorSources = await listCompetitorSources(session.user.tenantId);
  const newsSource = await getNewsSource(session.user.tenantId);
  // Created on first view rather than on first run, which is what makes the
  // feature's health legible before anything has run.
  const aiVisibilitySource = await ensureAiVisibilitySource(session.user.tenantId);
  const activeAiVisibilityPrompts = await listPrompts(session.user.tenantId, { status: "active" });
  // Grouped here rather than in the client component so CompetitorsEditor
  // never needs to know how sources relate to competitors -- it just indexes
  // by the id it already has.
  const sourcesByCompetitor: Record<string, Source[]> = {};
  for (const source of competitorSources) {
    if (!source.competitorId) continue;
    (sourcesByCompetitor[source.competitorId] ??= []).push(source);
  }
  // The same derivation the prompts page's "Profile changed since prompts were
  // generated" strip uses, expressed as one count: competitors added since the
  // newest active prompt was approved, plus the profile itself if it has been
  // edited since. Personas live in one JSON column with no per-persona
  // timestamp, so an edited profile is the only evidence a persona moved.
  const lastApprovedAt = activeAiVisibilityPrompts.reduce<Date | null>(
    (latest, prompt) =>
      prompt.approvedAt && (!latest || prompt.approvedAt > latest) ? prompt.approvedAt : latest,
    null
  );
  const aiVisibilityChangedSince = lastApprovedAt
    ? competitors.filter((competitor) => competitor.createdAt > lastApprovedAt).length +
      (brandProfile.updatedAt > lastApprovedAt ? 1 : 0)
    : 0;

  const personaCatalog = await db
    .select({
      key: systemPersonas.key,
      name: systemPersonas.name,
      description: systemPersonas.description,
    })
    .from(systemPersonas)
    .orderBy(systemPersonas.sortOrder);

  // Keys the context form on every server-derived field it shows, for the same
  // reason IndustrySelect and GuidelinesEditor below are keyed on their own
  // server value: a successful "Draft from my website" overwrites these
  // columns server-side and calls router.refresh(), but CompanyContextForm
  // seeds its inputs from `defaultValue` once and never looks again -- without
  // this key, a fresh draft would silently not appear until a hard reload.
  const contextKey = [
    brandProfile.websiteUrl,
    brandProfile.oneLiner,
    brandProfile.category,
    brandProfile.positioning,
    brandProfile.topics.join(","),
  ].join("|");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">Company</h1>
        <p className="text-sm text-muted-foreground">
          Who you are, what you&apos;re up against, and how your product updates should be written. Every draft is
          generated and reviewed against this.
        </p>
      </div>

      {/* Each card owns its own save: industry and persona add/remove write on
          click, a custom persona has a Save inside it, competitors add/remove
          write immediately, and the context and guidelines cards have their
          own forms below. There is deliberately no page-level Save. */}
      <Card id="company-context">
        <CardHeader>
          <CardTitle>Company context</CardTitle>
          <CardDescription>
            Who you are, what makes you different, and the subjects you cover. Used to score how relevant incoming
            signals are.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CompanyContextForm
            key={contextKey}
            defaultWebsiteUrl={brandProfile.websiteUrl ?? ""}
            defaultOneLiner={brandProfile.oneLiner ?? ""}
            defaultCategory={brandProfile.category ?? ""}
            defaultPositioning={brandProfile.positioning ?? ""}
            defaultTopics={brandProfile.topics.join(", ")}
          />
        </CardContent>
      </Card>

      <Card id="competitors">
        <CardHeader>
          <CardTitle>Competitors</CardTitle>
          <CardDescription>
            Who you&apos;re up against. The bootstrap above proposes some; add more by hand. A newly discovered
            source&apos;s first run only records a baseline of what&apos;s already published — it produces nothing
            until the competitor posts something new.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CompetitorsEditor competitors={competitors} sourcesByCompetitor={sourcesByCompetitor} />
        </CardContent>
      </Card>

      <Card id="industry-news">
        <CardHeader>
          <CardTitle>Industry news</CardTitle>
          <CardDescription>
            Opt in to a daily search of news coverage in your space. Costs a small amount of search budget per
            topic per day, so it&apos;s off until you turn it on.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NewsToggle source={newsSource} />
        </CardContent>
      </Card>

      <Card id="ai-visibility">
        <CardHeader>
          <CardTitle>AI visibility</CardTitle>
          <CardDescription>
            Measures how often ChatGPT, Perplexity, Gemini and Claude name you when buyers ask about your
            category. Costs a few dollars a month per workspace, so it&apos;s off until you turn it on.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AiVisibilityCard
            source={aiVisibilitySource}
            promptCount={activeAiVisibilityPrompts.length}
            competitorCount={competitors.length}
            personaCount={brandProfile.userPersonas.length}
            changedSinceCount={aiVisibilityChangedSince}
          />
        </CardContent>
      </Card>

      <Card id="industry">
        <CardHeader>
          <CardTitle>Industry</CardTitle>
          <CardDescription>Grounds updates in the language of your market — selects the writing exemplars generation draws on.</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Keyed on the server value. A successful import (BrandStyleImport,
              below) overwrites `industry` server-side and calls router.refresh(),
              which re-renders this page with the new brandProfile. IndustrySelect
              owns its selection as internal state, so without a key React would
              keep the existing instance and the new defaultValue would be
              silently ignored -- see the matching comment on GuidelinesEditor
              below for the full trade-off this accepts. */}
          <IndustrySelect key={brandProfile.industry ?? ""} defaultValue={brandProfile.industry ?? ""} />
        </CardContent>
      </Card>

      <Card id="user-personas">
        <CardHeader>
          <CardTitle>User personas</CardTitle>
          <CardDescription>Who each update is written for, and what they care about.</CardDescription>
        </CardHeader>
        <CardContent>
          <PersonasEditor personas={brandProfile.userPersonas} catalog={personaCatalog} />
        </CardContent>
      </Card>

      <Card id="derive-from-updates">
        <CardHeader>
          <CardTitle>Derive from your updates page</CardTitle>
        </CardHeader>
        <CardContent>
          <BrandStyleImport defaultUrl={brandProfile.updatesPageUrl ?? ""} />
        </CardContent>
      </Card>

      <Card id="guidelines">
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

      <Card id="visual-identity">
        <CardHeader>
          <CardTitle>Visual identity</CardTitle>
          <CardDescription>
            Palette, style and rules every generated image follows. Drafts get images only once at least three
            colors are saved here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Keyed on the server value for the same reason as GuidelinesEditor
              above: the editor seeds its state once from `initial`. */}
          <VisualIdentityEditor
            key={JSON.stringify(brandProfile.visualIdentity)}
            initial={brandProfile.visualIdentity}
            defaultWebsiteUrl={brandProfile.websiteUrl ?? ""}
          />
        </CardContent>
      </Card>

      {/* Absorbed from the retired /change-events and /atomic-updates pages
          (curation + bulk actions half; the single-item view half moved into
          the Signals evidence drawer). Both routes are now redirect stubs
          pointing here — these sections reuse the same components, re-pointed,
          rather than duplicating them. */}
      <Card id="change-events">
        <CardHeader>
          <CardTitle>Change events</CardTitle>
          <CardDescription>
            Commits, pull requests, and tasks the resolver hasn&apos;t grouped into an atomic update yet. An
            ungrouped event has no atomic update, so it has no signal — this is the only place to reach it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChangeEventsSection tenantId={session.user.tenantId} searchParams={params} />
        </CardContent>
      </Card>

      <Card id="atomic-updates">
        <CardHeader>
          <CardTitle>Atomic updates</CardTitle>
          <CardDescription>
            Every atomic update ever produced. Unlike the Signals feed, this isn&apos;t limited to the last 60 days
            — it&apos;s the only place to reach one older than that.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AtomicUpdatesSection tenantId={session.user.tenantId} searchParams={params} />
        </CardContent>
      </Card>
    </div>
  );
}
