import { describe, it, expect } from "vitest";
import {
  clampStep,
  resolveOnboardingRedirect,
  ONBOARDING_STEP_PATHS,
} from "../../../src/lib/workspace/onboarding-step";

describe("clampStep", () => {
  it("keeps valid steps", () => {
    expect(clampStep(1)).toBe(1);
    expect(clampStep(4)).toBe(4);
  });

  it("clamps out-of-range and non-integer values", () => {
    expect(clampStep(0)).toBe(1);
    expect(clampStep(-3)).toBe(1);
    expect(clampStep(9)).toBe(4);
    expect(clampStep(2.7)).toBe(2);
  });
});

describe("resolveOnboardingRedirect", () => {
  it("sends a finished tenant to the dashboard from any step", () => {
    expect(resolveOnboardingRedirect({ completed: true, storedStep: 1, requestedStep: 3 })).toBe("/atomic-updates");
    expect(resolveOnboardingRedirect({ completed: true, storedStep: 4, requestedStep: 4 })).toBe("/atomic-updates");
  });

  it("renders the requested step when it is the stored one", () => {
    expect(resolveOnboardingRedirect({ completed: false, storedStep: 2, requestedStep: 2 })).toBeNull();
  });

  // Back-navigation must work: the routes are real URLs and the browser Back
  // button is the only way back through the wizard.
  it("renders an earlier step without redirecting", () => {
    expect(resolveOnboardingRedirect({ completed: false, storedStep: 3, requestedStep: 1 })).toBeNull();
  });

  it("blocks jumping ahead of the stored step", () => {
    expect(resolveOnboardingRedirect({ completed: false, storedStep: 1, requestedStep: 4 })).toBe(
      ONBOARDING_STEP_PATHS[1]
    );
    expect(resolveOnboardingRedirect({ completed: false, storedStep: 3, requestedStep: 4 })).toBe(
      ONBOARDING_STEP_PATHS[3]
    );
  });

  it("clamps a corrupt stored step rather than redirecting nowhere", () => {
    expect(resolveOnboardingRedirect({ completed: false, storedStep: 0, requestedStep: 2 })).toBe(
      ONBOARDING_STEP_PATHS[1]
    );
  });

  it("maps every step to its route", () => {
    expect(ONBOARDING_STEP_PATHS).toEqual({
      1: "/onboarding/workspace",
      2: "/onboarding/brand",
      3: "/onboarding/connect",
      4: "/onboarding/schedule",
    });
  });
});
