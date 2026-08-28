import Link from "next/link";
import { Inbox, Radar, ScanSearch, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";
import { cn } from "@/lib/utils";

/**
 * Public marketing page shown at `/` to unauthenticated visitors. Signed-in
 * visitors never reach this component -- `src/app/page.tsx` branches before
 * rendering it. See that file for the auth check.
 */

const HOW_IT_WORKS = [
  {
    icon: Radar,
    title: "Listen to every signal",
    body: "Versional continuously collects five kinds of signal — what you ship, what competitors do, what the market says, and more — and tracks whether each source is still working.",
  },
  {
    icon: ScanSearch,
    title: "See what AI already thinks",
    body: "Real prompts run on a schedule against ChatGPT, Perplexity, Gemini, and Claude, turning your share-of-voice and citation trend into a signal in the same pipeline.",
  },
  {
    icon: Inbox,
    title: "Skip the blank page",
    body: "Related signals cluster into a proposed brief — title, angle, “why now,” key points, and a confidence score — waiting in an inbox for a yes or no.",
  },
  {
    icon: ShieldCheck,
    title: "Ship with the evidence attached",
    body: "Every signal keeps its source excerpt and rationale, every brief keeps the signals that justified it, and every run shows live progress and a preflight check before anything goes out.",
  },
];

const FEATURES = [
  {
    icon: Radar,
    title: "Five signals. One feed.",
    body: "Versional continuously collects five kinds of signal — shipped work, competitor moves, market news, AI-visibility gaps, and anything you add by hand. Each source carries a health status, so a quiet integration shows up as failing, not silence.",
  },
  {
    icon: Inbox,
    title: "Briefs, not blank pages.",
    body: "Signals cluster automatically into a proposed brief — a title, an angle, a “why now,” and the key points, each with a confidence score and rationale attached. You sit in an inbox and accept or dismiss; nothing gets written until you say go.",
  },
  {
    icon: ScanSearch,
    title: "See what the AI engines say about you.",
    body: "Versional runs real prompts against ChatGPT, Perplexity, Gemini, and Claude, then tracks your share-of-voice and citation rate as a trend rather than a single number. Results write straight into the same brief pipeline as everything else.",
  },
  {
    icon: ShieldCheck,
    title: "Every claim has a source.",
    body: "Every signal keeps its relevance score, rationale, and source excerpt; every brief keeps the signals that justified it. Automated runs show live progress and a preflight checklist, so speed never means losing track of why something happened.",
  },
];

function PrimaryCta({ className }: { className?: string }) {
  return (
    <Link href="/signin" className={cn(buttonVariants({ variant: "default", size: "lg" }), className)}>
      Start listening
    </Link>
  );
}

export function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
          <Logo />
          <Link
            href="/signin"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="flex-1">
        {/* a) Hero */}
        <section className="mx-auto w-full max-w-4xl px-6 pt-20 pb-16 text-center">
          <h1 className="font-heading text-5xl leading-[1.1] tracking-[0.015em] text-balance sm:text-6xl">
            Get noticed before they do.
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground text-balance">
            Versional listens to what you ship, what your competitors do, what the market&apos;s
            saying, and whether ChatGPT and Perplexity mention you at all — then turns what matters
            into evidence-backed content briefs you approve in seconds.
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <PrimaryCta />
            <a href="#sample-brief" className={cn(buttonVariants({ variant: "outline", size: "lg" }))}>
              See a sample brief
            </a>
          </div>
        </section>

        {/* b) How it works */}
        <section className="border-t border-border bg-muted/40">
          <div className="mx-auto w-full max-w-6xl px-6 py-16">
            <h2 className="text-center text-2xl font-medium">How it works</h2>
            <div className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
              {HOW_IT_WORKS.map((step, index) => (
                <div key={step.title} className="flex flex-col items-start gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-subtle font-mono text-xs font-medium text-brand-subtle-foreground">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <step.icon className="size-4 text-muted-foreground" aria-hidden="true" />
                  </div>
                  <h3 className="text-sm font-medium">{step.title}</h3>
                  <p className="text-sm text-muted-foreground">{step.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* c) Feature cards */}
        <section className="mx-auto w-full max-w-6xl px-6 py-16">
          <div className="grid gap-4 sm:grid-cols-2">
            {FEATURES.map((feature) => (
              <Card key={feature.title}>
                <CardContent className="flex flex-col gap-3">
                  <span className="flex size-9 items-center justify-center rounded-lg bg-brand-subtle">
                    <feature.icon className="size-4.5 text-brand-subtle-foreground" aria-hidden="true" />
                  </span>
                  <h3 className="font-sans text-base font-medium">{feature.title}</h3>
                  <p className="text-sm text-muted-foreground">{feature.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* d) Trust */}
        <section className="border-t border-border bg-muted/40">
          <div className="mx-auto w-full max-w-3xl px-6 py-16 text-center">
            <h2 className="text-2xl font-medium text-balance">Judge the mechanism, not the client list.</h2>
            <p className="mt-4 text-muted-foreground text-balance">
              Versional is new, so instead of testimonials, every signal ships with its source excerpt
              and relevance rationale, every brief lists the exact signals that justified it, and every
              automated run passes a preflight checklist before anything publishes — check the reasoning
              yourself rather than take our word for it.
            </p>
          </div>
        </section>

        {/* e) Sample content piece */}
        <section id="sample-brief" className="mx-auto w-full max-w-3xl scroll-mt-8 px-6 py-16">
          <div className="mb-6 text-center">
            <h2 className="text-2xl font-medium">A sample brief, published</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              What comes out the other end of the pipeline.
            </p>
          </div>
          <Card>
            <CardContent className="flex flex-col gap-4">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">AI-generated</Badge>
                <Badge variant="outline">Human-approved</Badge>
              </div>
              <blockquote className="space-y-4 border-l-2 border-brand-ink/30 pl-4 text-sm leading-relaxed text-foreground">
                <p className="font-medium">We shipped bulk delete for the signals browser.</p>
                <p>
                  Until this week, clearing out noise meant deleting one signal at a time. Now you can
                  select a batch, confirm the count, and remove them in one pass.
                </p>
                <p>
                  The detail worth stating plainly: a deleted signal only drops out of any brief that
                  cited it as evidence. The brief itself, and its other supporting signals, stay intact.
                  Cleanup doesn&apos;t rewrite your reasoning after the fact.
                </p>
                <p>
                  Small feature. But it&apos;s the kind of thing that matters once you&apos;re treating
                  signals as an audit trail rather than a scratch pad — the trail has to survive editing,
                  not just creation.
                </p>
              </blockquote>
              <p className="text-xs text-muted-foreground">
                — Generated from a shipped_work signal, confidence 0.91. Reviewed and approved by a
                human before publishing.
              </p>
            </CardContent>
          </Card>
        </section>

        {/* f) Final CTA */}
        <section className="border-t border-border bg-muted/40">
          <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-6 px-6 py-20 text-center">
            <h2 className="font-heading text-3xl leading-[1.15] tracking-[0.015em] text-balance">
              Get noticed before they do.
            </h2>
            <PrimaryCta />
          </div>
        </section>
      </main>

      <footer className="border-t border-border px-6 py-8">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between text-sm text-muted-foreground">
          <Logo className="scale-90" />
          <span>&copy; {new Date().getFullYear()} Versional</span>
        </div>
      </footer>
    </div>
  );
}
