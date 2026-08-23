import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  CitedDomainsTable,
  domainClassLabel,
  evidenceNote,
  type CitedDomainRow,
} from "../../../src/app/(dashboard)/ai-visibility/cited-domains-table";

function domain(overrides: Partial<CitedDomainRow> = {}): CitedDomainRow {
  return {
    domain: "g2.com",
    citations: 14,
    answerSharePct: 17,
    engines: ["openai", "gemini"],
    domainClass: "review",
    signalId: "signal-1",
    everSignalled: true,
    ...overrides,
  };
}

describe("domainClassLabel", () => {
  it("collapses the seven classes into the three the row has room for", () => {
    expect(domainClassLabel(domain({ domainClass: "own" })).label).toBe("Ours");
    expect(domainClassLabel(domain({ domainClass: "competitor" })).label).toBe("Competitor");
    expect(domainClassLabel(domain({ domainClass: "review" })).label).toBe("Third-party");
    expect(domainClassLabel(domain({ domainClass: "wiki" })).label).toBe("Third-party");
  });
});

describe("evidenceNote", () => {
  it("names an expiry only where a signal existed to expire", () => {
    expect(evidenceNote(domain({ everSignalled: true }))!.label).toBe("Evidence aged out");
    expect(evidenceNote(domain({ everSignalled: false }))!.label).toBe("No signal yet");
  });

  it("tells the never-signalled reader what would have to happen, and where to go meanwhile", () => {
    const hint = evidenceNote(domain({ everSignalled: false }))!.hint;
    expect(hint).toContain("top 10");
    expect(hint).toContain("Signals page");
    expect(hint).not.toContain("60-day");
  });

  it("says nothing at all on a table that never joined to signals", () => {
    expect(evidenceNote(domain({ signalId: null, everSignalled: null }))).toBeNull();
  });
});

describe("CitedDomainsTable", () => {
  it("offers Propose brief on a third-party row, prefilled with that signal", () => {
    render(<CitedDomainsTable rows={[domain()]} />);

    expect(screen.getByRole("link", { name: "Propose brief" })).toHaveAttribute(
      "href",
      "/briefs/new?signals=signal-1"
    );
  });

  it("offers it on no other class — our own page is not a placement gap", () => {
    render(<CitedDomainsTable rows={[domain({ domainClass: "own" })]} />);

    expect(screen.queryByRole("link", { name: "Propose brief" })).not.toBeInTheDocument();
  });

  it("withholds it when no signal was emitted, and says why rather than leaving a blank cell", () => {
    render(<CitedDomainsTable rows={[domain({ signalId: null })]} />);

    expect(screen.queryByRole("link", { name: "Propose brief" })).not.toBeInTheDocument();
    expect(screen.getByText("Evidence aged out")).toBeInTheDocument();
  });

  it("does not claim an expiry on a domain that never raised a signal", () => {
    // The common case, not the edge one: `new_cited_domain` fires on entry, so
    // a source the engines have leaned on for months never emitted anything
    // there was anything to age out of.
    render(<CitedDomainsTable rows={[domain({ signalId: null, everSignalled: false })]} />);

    expect(screen.getByText("No signal yet")).toBeInTheDocument();
    expect(screen.queryByText("Evidence aged out")).not.toBeInTheDocument();
  });

  it("puts the explanation on a focusable control, not in a title attribute", () => {
    // `title` opens on hover and on nothing else. The sentence explaining why a
    // whole column of actions is missing has to be reachable by keyboard.
    render(<CitedDomainsTable rows={[domain({ signalId: null })]} />);

    const trigger = screen.getByRole("button", { name: "Evidence aged out" });
    expect(trigger).toBeInTheDocument();
    expect(trigger.closest("[title]")).toBeNull();
  });

  it("leaves the per-prompt sources table silent — it asked the signals table nothing", () => {
    // Every row there passes `signalId: null` by construction, so a note would
    // announce an expiry on every third-party domain the prompt ever cited.
    render(<CitedDomainsTable rows={[domain({ signalId: null, everSignalled: null })]} />);

    expect(screen.queryByText("Evidence aged out")).not.toBeInTheDocument();
    expect(screen.queryByText("No signal yet")).not.toBeInTheDocument();
  });

  it("explains nothing on our own row — being cited there is the outcome, not a gap", () => {
    render(<CitedDomainsTable rows={[domain({ domainClass: "own", signalId: null })]} />);

    expect(screen.queryByText("Evidence aged out")).not.toBeInTheDocument();
    expect(screen.queryByText("No signal yet")).not.toBeInTheDocument();
  });

  it("shows the count and the share of answers, not one without the other", () => {
    render(<CitedDomainsTable rows={[domain()]} />);

    expect(screen.getByText("14 (17% of searched answers)")).toBeInTheDocument();
  });
});
