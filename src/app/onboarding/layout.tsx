import { Logo } from "@/components/brand/logo";

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col px-6 py-24">
      <div className="absolute left-6 top-6">
        <Logo />
      </div>
      {/* `m-auto` rather than `items-center`: auto margins collapse to zero when
          the content is taller than the viewport, so a long step (step 3 with a
          full repo list) starts at the top padding and scrolls normally instead
          of having its top clipped out of the scroll area. */}
      <div className="m-auto w-full max-w-lg space-y-8">{children}</div>
    </div>
  );
}
