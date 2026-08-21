import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  CitedDomainsTable,
  domainClassLabel,
  type CitedDomainRow,
} from "../../../src/app/(dashboard)/ai-visibility/cited-domains-table";

function domain(overrides: Partial<CitedDomainRow> = {}): CitedDomainRow {
  return {
    domain: "g2.com",
    citations: 14,
    answerSharePct: 17,
    engines: ["openai", "perplexity"],
    domainClass: "review",
    signalId: "signal-1",
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

  it("explains nothing on our own row — being cited there is the outcome, not a gap", () => {
    render(<CitedDomainsTable rows={[domain({ domainClass: "own", signalId: null })]} />);

    expect(screen.queryByText("Evidence aged out")).not.toBeInTheDocument();
  });

  it("shows the count and the share of answers, not one without the other", () => {
    render(<CitedDomainsTable rows={[domain()]} />);

    expect(screen.getByText("14 (17% of answers)")).toBeInTheDocument();
  });
});
