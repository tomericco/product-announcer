import { LAST_ONBOARDING_STEP, type OnboardingStep } from "@/lib/workspace/onboarding-step";

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
    <div className="space-y-1.5">
      <p className="text-muted-foreground text-xs font-medium">
        Step {step} of {LAST_ONBOARDING_STEP}
      </p>
      <h1 className="text-2xl font-semibold leading-[1.2] tracking-[-0.01em]">{title}</h1>
      {description && <p className="text-muted-foreground text-sm">{description}</p>}
    </div>
  );
}
