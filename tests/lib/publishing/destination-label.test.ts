import { describe, it, expect } from "vitest";
import { destinationLabel } from "../../../src/lib/publishing/dispatch";

describe("destinationLabel", () => {
  it("returns the registry label for a known destination", () => {
    expect(destinationLabel("webhook")).toBe("Webhook");
    expect(destinationLabel("webflow")).toBe("Webflow");
  });

  it("falls back to the raw id for an unknown destination", () => {
    // A row whose destination was since removed from the registry still renders
    // something rather than blank.
    expect(destinationLabel("mailchimp" as never)).toBe("mailchimp");
  });
});
