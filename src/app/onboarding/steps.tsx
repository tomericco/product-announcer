import { LAST_ONBOARDING_STEP, type OnboardingStep } from "@/lib/workspace/onboarding-step";
import { cn } from "@/lib/utils";

export function StepHeader({
  step,
  title,
  description,
}: {
  step: OnboardingStep;
  title: string;
  description?: string;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2" aria-hidden>
        {Array.from({ length: LAST_ONBOARDING_STEP }, (_, i) => (
          <span
            key={i}
            className={cn("h-1.5 flex-1 rounded-full", i < step ? "bg-primary" : "bg-muted")}
          />
        ))}
      </div>
      <div className="space-y-1.5">
        <p className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
          Step {step} of {LAST_ONBOARDING_STEP}
        </p>
        <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">{title}</h1>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
    </div>
  );
}
