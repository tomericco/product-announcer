import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

/**
 * `/briefs/new` — the hand-written brief, driven for real in jsdom. This page
 * is the same markdown editor `/briefs/[briefId]` is, so what has to be pinned
 * here is what only this page does: the template it starts from, the two
 * fields the editor cannot infer, and the fact that nothing is written until
 * Create is pressed.
 *
 * Four module mocks, every one of them a thing unreachable in jsdom rather
 * than an assertion being dodged:
 *
 *   - `briefs/new/actions` is a `"use server"` module that imports `@/db`; the
 *     jsdom project has no DATABASE_URL. `createManualBrief` itself is covered
 *     by tests/app/briefs-new-actions.test.ts. Here it is a spy, which is also
 *     how "Cancel creates nothing" and "the untouched template creates
 *     nothing" are asserted rather than assumed.
 *   - `next/navigation`'s `useRouter` throws outside a mounted App Router.
 *   - `unsaved-changes` renders a Dialog and uses the router; mocking it also
 *     makes "did this page arm the leave guard?" directly assertable.
 *   - `brief-mdx-editor` is the module that imports `@mdxeditor/editor` for
 *     real. Note what is NOT mocked: `BriefBodyEditor`, its `ssr: false`
 *     dynamic import, and the page's own wiring all run, so these tests fail
 *     if the page stops reusing the shared editor.
 *
 * Spies come through `vi.hoisted` because `vi.mock` factories hoist above
 * every top-level statement in this file.
 */
const { createManualBrief, push, setSectionDirty, notifySaved } = vi.hoisted(() => ({
  createManualBrief: vi.fn(),
  push: vi.fn(),
  setSectionDirty: vi.fn(),
  notifySaved: vi.fn(),
}));

vi.mock("../../src/app/(dashboard)/briefs/new/actions", () => ({ createManualBrief }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("../../src/app/(dashboard)/unsaved-changes", () => ({
  useUnsavedChanges: () => ({
    isDirty: false,
    setSectionDirty,
    cleanToken: 0,
    notifySaved,
    requestLeave: () => {},
  }),
  GuardedLink: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

// The seeded markdown arrives here as `markdown`; the textarea is how a test
// plays the human typing into the editor.
vi.mock("../../src/app/(dashboard)/briefs/[briefId]/brief-mdx-editor", () => ({
  default: ({
    markdown,
    onChange,
  }: {
    markdown: string;
    onChange: (md: string, initialMarkdownNormalize: boolean) => void;
  }) => (
    <textarea
      aria-label="Brief body"
      defaultValue={markdown}
      onChange={(event) => onChange(event.target.value, false)}
    />
  ),
}));

import { NewBriefEditor } from "../../src/app/(dashboard)/briefs/new/new-brief-editor";
import { BRIEF_TEMPLATE, UNFILLED_BRIEF_TEMPLATE_ERROR } from "../../src/lib/briefs/body";
import { contentTypeEnum } from "../../src/db/schema";
import type { CitedSignal } from "../../src/lib/briefs/query";

const EVIDENCE: CitedSignal[] = [
  { id: "sig-1", title: "Shipped the export flow", url: null, kind: "shipped_work" },
  { id: "sig-2", title: "Competitor shipped exports", url: "https://example.com/x", kind: "competitor_move" },
];

const WRITTEN = ["## Angle", "Ship the export flow as the headline.", "", "## Why now", "They just shipped theirs."].join(
  "\n"
);

/**
 * Mounts the page's client half and waits out the `ssr: false` dynamic import
 * of the body editor, which resolves a tick after the first render.
 */
async function renderEditor(evidence: CitedSignal[] = []) {
  render(<NewBriefEditor evidence={evidence} />);
  await waitFor(() => expect(screen.getByLabelText("Brief body")).toBeInTheDocument());
}

function typeTitle(value: string) {
  fireEvent.input(screen.getByLabelText("Title"), { target: { value } });
}

function typeBody(value: string) {
  fireEvent.change(screen.getByLabelText("Brief body"), { target: { value } });
}

/** Base UI's select opens on click; the option commits on Enter. */
async function chooseContentType(label: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("combobox", { name: "Content type" }));
  });
  const option = screen.getByRole("option", { name: label });
  await act(async () => {
    option.focus();
    fireEvent.keyDown(option, { key: "Enter" });
    fireEvent.keyUp(option, { key: "Enter" });
  });
}

async function clickCreate() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Create brief" }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  createManualBrief.mockResolvedValue({ ok: true, briefId: "brief-9" });
});

describe("NewBriefEditor — the surface", () => {
  it("seeds the editor with the brief template", async () => {
    await renderEditor();

    expect(screen.getByLabelText("Brief body")).toHaveValue(BRIEF_TEMPLATE);
  });

  it("offers every content type the schema has, so none is unreachable here", async () => {
    // Read off the enum rather than restated: a fourth content type added to
    // the schema and forgotten here is exactly the failure worth catching,
    // and `generateDraftForPiece` forks on this value.
    await renderEditor();

    await act(async () => {
      fireEvent.click(screen.getByRole("combobox", { name: "Content type" }));
    });

    expect(screen.getAllByRole("option")).toHaveLength(contentTypeEnum.enumValues.length);
    for (const value of contentTypeEnum.enumValues) {
      expect(screen.getByRole("option", { name: new RegExp(value.replace("_", " "), "i") })).toBeInTheDocument();
    }
  });

  it("shows the evidence a ?signals= visit resolved, and says it is attached", async () => {
    await renderEditor(EVIDENCE);

    expect(screen.getByText("Shipped the export flow")).toBeInTheDocument();
    expect(screen.getByText("Competitor shipped exports")).toBeInTheDocument();
    expect(screen.getByText(/attached as evidence/)).toBeInTheDocument();
  });

  it("says where a hand-written brief lands when nothing was attached", async () => {
    await renderEditor();

    expect(screen.getByText(/Write a brief by hand/)).toBeInTheDocument();
  });
});

describe("NewBriefEditor — Create", () => {
  it("sends the edited body, the title and the chosen content type", async () => {
    await renderEditor();

    typeTitle("Exports, finally");
    typeBody(WRITTEN);
    await chooseContentType("Product update");
    await clickCreate();

    expect(createManualBrief).toHaveBeenCalledTimes(1);
    expect(createManualBrief).toHaveBeenCalledWith({
      contentType: "product_update",
      title: "Exports, finally",
      body: WRITTEN,
      // The NOT NULL columns this page does not collect. Pinned deliberately:
      // they are safe as "" only because `body` is set, so `briefBody`'s
      // fallback never renders from them.
      angle: "",
      whyNow: "",
      keyPoints: [],
      audience: null,
      suggestedChannel: "",
      targetLength: null,
      score: 0.5,
      scoreRationale: null,
      signalIds: [],
    });
  });

  it("attaches the evidence the page resolved, which is what the modal's fallback is for", async () => {
    await renderEditor(EVIDENCE);

    typeTitle("Exports, finally");
    typeBody(WRITTEN);
    await clickCreate();

    expect(createManualBrief).toHaveBeenCalledWith(
      expect.objectContaining({ signalIds: ["sig-1", "sig-2"] })
    );
  });

  it("lands on the board once the brief exists", async () => {
    await renderEditor();

    typeTitle("Exports, finally");
    typeBody(WRITTEN);
    await clickCreate();

    await waitFor(() => expect(push).toHaveBeenCalledWith("/board"));
  });

  it("surfaces a server refusal and stays on the page rather than pretending it landed", async () => {
    createManualBrief.mockResolvedValue({ ok: false, error: "One or more selected signals could not be found." });
    await renderEditor(EVIDENCE);

    typeTitle("Exports, finally");
    typeBody(WRITTEN);
    await clickCreate();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "One or more selected signals could not be found."
    );
    expect(push).not.toHaveBeenCalled();
  });
});

/**
 * The page refuses this itself rather than letting it reach the server: the
 * blank guard in `createManualBrief` cannot catch it — a template is not
 * blank, it is four headings and a bullet — and there is nothing to learn from
 * a round trip whose answer is knowable on screen.
 */
describe("NewBriefEditor — the untouched template", () => {
  it("refuses to create a brief from a template nobody typed into", async () => {
    await renderEditor();

    typeTitle("Exports, finally");
    await clickCreate();

    expect(createManualBrief).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(UNFILLED_BRIEF_TEMPLATE_ERROR);
    expect(push).not.toHaveBeenCalled();
  });

  it("refuses it after the editor has normalized the markdown, not only byte-for-byte", async () => {
    await renderEditor();

    typeTitle("Exports, finally");
    typeBody(["## Angle", "", "## Why now", "", "## Key points", "", "* ", "", "## Audience", ""].join("\n"));
    await clickCreate();

    expect(createManualBrief).not.toHaveBeenCalled();
  });

  it("creates as soon as one section has been written into", async () => {
    await renderEditor();

    typeTitle("Exports, finally");
    typeBody(BRIEF_TEMPLATE.replace("## Angle\n", "## Angle\nShip it as the headline.\n"));
    await clickCreate();

    expect(createManualBrief).toHaveBeenCalledTimes(1);
  });

  it("will not create an untitled brief either", async () => {
    await renderEditor();

    typeBody(WRITTEN);

    expect(screen.getByRole("button", { name: "Create brief" })).toBeDisabled();
  });
});

/**
 * Nothing is saved until Create. That is the whole reason this stayed a page
 * instead of becoming a create-then-redirect action, and it is only safe if
 * walking away is guarded and Cancel writes nothing.
 */
describe("NewBriefEditor — leaving", () => {
  it("Cancel goes back to the board and creates nothing", async () => {
    await renderEditor();

    typeTitle("Exports, finally");
    typeBody(WRITTEN);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    expect(createManualBrief).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/board");
  });

  it("arms the leave guard once something has been written, since nothing is saved yet", async () => {
    await renderEditor();

    typeBody(WRITTEN);

    expect(setSectionDirty).toHaveBeenCalledWith("new-brief-body", true);
  });

  it("clears the guard on unmount, so no stale warning is left armed", async () => {
    const { unmount } = render(<NewBriefEditor evidence={[]} />);
    await waitFor(() => expect(screen.getByLabelText("Brief body")).toBeInTheDocument());
    typeBody(WRITTEN);
    setSectionDirty.mockClear();

    unmount();

    expect(setSectionDirty).toHaveBeenCalledWith("new-brief-title", false);
    expect(setSectionDirty).toHaveBeenCalledWith("new-brief-body", false);
  });
});
