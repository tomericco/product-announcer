import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The plain import path — `ImportDialog`'s DEFAULT submit handlers, which put
 * the selected events into the ungrouped pool for the resolver to cluster
 * (`importCommits` / `importPullRequests` / `importTasks`) — is reachable only
 * when some caller renders the dialog WITHOUT overriding them.
 *
 * It stopped being reachable when `/change-events` was retired: that page was
 * the only bare render, and both surviving callers override all three handlers
 * to funnel the selection into one atomic update instead
 * (`new-atomic-update-dialog.tsx` creates one, `company/add-event-picker.tsx`
 * adds to an existing one). Nothing failed — three `"use server"` actions
 * simply became dead code and the backfill capability disappeared.
 *
 * That is a wiring property, not a value a unit test can call: there is no
 * jsdom here (vitest runs the "node" environment), and importing the dialog
 * would drag `@/db` in through its server actions. So this pins the wiring at
 * the source level, the way tests/components/brand/mark-path.test.ts pins the
 * favicon against the shared mark constants.
 */

const root = join(__dirname, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const integrationsPage = read("src/app/(dashboard)/integrations/page.tsx");
const importDialog = read("src/app/(dashboard)/integrations/import-dialog.tsx");

/** The JSX element for `<ImportDialog …/>`, if the file renders one directly. */
function importDialogElement(source: string): string | null {
  const start = source.indexOf("<ImportDialog");
  if (start === -1) return null;
  const end = source.indexOf("/>", start);
  return end === -1 ? null : source.slice(start, end);
}

describe("the plain (ungrouped) import path", () => {
  it("is rendered somewhere — the Integrations page renders ImportDialog directly", () => {
    expect(importDialogElement(integrationsPage)).not.toBeNull();
  });

  it("is rendered with NO submit overrides, which is the only thing that makes the defaults run", () => {
    const element = importDialogElement(integrationsPage)!;
    expect(element).not.toContain("commitSubmit");
    expect(element).not.toContain("pullRequestSubmit");
    expect(element).not.toContain("taskSubmit");
  });

  it("is rendered with no custom trigger, so the missing-connection hint still applies", () => {
    // `ImportDialog` only renders its `DisabledHint` ("Connect GitHub or
    // Notion to import changes") for the DEFAULT trigger — a caller supplying
    // one owns its own disabled state. Passing a trigger here would silently
    // opt out of the page's existing missing-connection handling.
    expect(importDialogElement(integrationsPage)!).not.toContain("trigger");
    expect(importDialog).toContain("if (!trigger && noImportSources)");
  });

  it("still routes its defaults at the three ungrouped-import actions", () => {
    // The other half of the contract: the defaults the page relies on must
    // remain the plain-import ones. If a future change re-points them, the
    // page's bare render would quietly mean something else.
    for (const action of ["importCommits", "importPullRequests", "importTasks"]) {
      expect(importDialog).toContain(`await ${action}({ selections: sel })`);
    }
  });

  it("lands the events where the actions revalidate", () => {
    // The ungrouped queue is the Company page's change-events section now, not
    // the retired /change-events route, and all three actions revalidate
    // /company accordingly.
    const importActions = read("src/app/(dashboard)/integrations/import-actions.ts");
    expect(importActions).not.toContain('revalidatePath("/change-events")');
    expect(importActions).not.toContain('revalidatePath("/atomic-updates")');
    expect(importActions).toContain('revalidatePath("/company")');
  });
});
