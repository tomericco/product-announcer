import { Logo } from "@/components/brand/logo";

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen p-6 py-16">
      <div className="mx-auto w-full max-w-lg space-y-8">
        <Logo />
        {children}
      </div>
    </div>
  );
}
