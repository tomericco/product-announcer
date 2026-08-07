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

  it("gives the brief case its own message instead of the generic 'can no longer be edited' fallback", () => {
    // A "brief" was never editable in the first place, so the generic
    // fallback's "can no longer be edited" (which implies it once was) would
    // read oddly — this pins the dedicated branch added in Task 6.
    const message = notEditableMessage("brief");
    expect(message).toMatch(/hasn't been generated yet/i);
    expect(message).not.toMatch(/^This update is brief/);
    expect(message).not.toMatch(/can no longer be edited/);
  });
});
