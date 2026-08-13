import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * Minimal proof that the jsdom project is wired correctly: a real DOM
 * global, `@testing-library/react` rendering, and jest-dom matchers all
 * work end to end. Not a test of application code.
 */
describe("jsdom project", () => {
  it("has a real DOM and can render a component into it", () => {
    expect(typeof document).not.toBe("undefined");

    render(<div data-testid="probe">hello</div>);

    expect(screen.getByTestId("probe")).toBeInTheDocument();
  });
});
