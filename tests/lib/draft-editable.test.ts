import { describe, it, expect } from "vitest";
import { assertDraftEditable, notEditableMessage } from "../../src/lib/draft-editable";

describe("assertDraftEditable", () => {
  it("permits a draft", () => {
    expect(() => assertDraftEditable({ status: "draft" })).not.toThrow();
  });

  it("refuses a published release, naming publication", () => {
    expect(() => assertDraftEditable({ status: "published" })).toThrow(/already been published/i);
  });

  it("refuses an archived piece", () => {
    expect(() => assertDraftEditable({ status: "archived" })).toThrow(/archived/i);
  });

  it("refuses a piece under review", () => {
    expect(() => assertDraftEditable({ status: "review" })).toThrow(/review/i);
  });
});

describe("notEditableMessage", () => {
  it("never leaks the raw enum value for the published case", () => {
    // "published" reads naturally in prose; the others fall back to naming the
    // status, so only this one gets bespoke wording worth pinning.
    expect(notEditableMessage("published")).not.toMatch(/is published/);
    expect(notEditableMessage("published")).toMatch(/can no longer be edited/);
  });
});
