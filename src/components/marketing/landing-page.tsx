import { Logo } from "@/components/brand/logo";
import { WaitlistForm } from "@/components/marketing/waitlist-form";

/**
 * Stealth-mode public page shown at `/` to unauthenticated visitors. Signed-in
 * visitors never reach this component -- `src/app/page.tsx` branches before
 * rendering it. Deliberately minimal: one clue, one waitlist form, no sign-in
 * entry point. See src/components/marketing/landing-page.tsx history (commit
 * 9da2bc5) for the full positioning-driven page to bring back out of stealth.
 */
export function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="px-6 py-6">
        <Logo />
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <h1 className="font-heading text-4xl leading-[1.1] tracking-[0.015em] text-balance sm:text-5xl">
          Get noticed before they do.
        </h1>
        <p className="mt-4 max-w-md text-muted-foreground text-balance">
          A new era for growth teams...
        </p>
        <div className="mt-10">
          <WaitlistForm />
        </div>
      </main>

      <footer className="px-6 py-8 text-center text-sm text-muted-foreground">
        &copy; {new Date().getFullYear()} Versional
      </footer>
    </div>
  );
}
