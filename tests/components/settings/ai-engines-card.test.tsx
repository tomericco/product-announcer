import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup, within } from "@testing-library/react";
import type { EngineId } from "../../../src/lib/ai-visibility/types";
import type { EngineKeyStatus } from "../../../src/lib/ai-visibility/engine-keys";
import {
  AiEnginesCard,
  type EngineKeyRow,
} from "../../../src/app/(dashboard)/settings/ai-engines-card";

/**
 * The AI-engines card — the only place an engine can be switched on, and the
 * only place a provider secret is ever typed.
 *
 * Four properties are asserted here that no other test in the suite can reach,
 * because they are properties of the RENDER rather than of a server action:
 *
 * 1. **Write-once at the DOM.** The card is handed `EngineKeyRow`s, which carry
 *    `last4` and nothing longer. The assertions are about an ABSENCE — no input
 *    is ever given a `value`/`defaultValue` drawn from stored state, and the
 *    only fragment of a key in the document is four characters. A read-back
 *    path would have to put the key somewhere, and this is where it would show.
 * 2. **The five states the design lists.** Not connected / verifying / verified
 *    and in use / verified and off / each failure badge. Decision 4's rule is
 *    "four states, never three", and a badge that reads the same for two
 *    different causes tells a marketer to fix the wrong thing.
 * 3. **The switch only exists over a verified key.** VS Code's structural idea:
 *    the contradictory state — an engine switched on with nothing that can
 *    answer for it — is unreachable rather than discouraged.
 * 4. **Owner-only, rendered honestly.** A member sees every row, every status
 *    and every last-4 and can change nothing. Not a hidden card: a permission.
 *
 * The four server actions are the network seam and are mocked. What is under
 * test is which one the card calls, with what, and when it refuses to call at
 * all — never what the server does with the call.
 */

type ActionResult = { ok: boolean; error?: string; keys?: EngineKeyRow[] };

const { saveEngineKeyAction, recheckEngineKeyAction, toggleEngineKeyAction, removeEngineKeyAction } =
  vi.hoisted(() => {
    const ok = async (): Promise<{ ok: boolean; error?: string; keys?: unknown[] }> => ({
      ok: true,
      keys: [],
    });
    return {
      saveEngineKeyAction: vi.fn(ok as (data: FormData) => Promise<ActionResult>),
      recheckEngineKeyAction: vi.fn(ok as (engine: unknown) => Promise<ActionResult>),
      toggleEngineKeyAction: vi.fn(ok as (engine: unknown, on: unknown) => Promise<ActionResult>),
      removeEngineKeyAction: vi.fn(ok as (engine: unknown) => Promise<ActionResult>),
    };
  });

vi.mock("../../../src/app/(dashboard)/settings/engine-key-actions", () => ({
  saveEngineKeyAction,
  recheckEngineKeyAction,
  toggleEngineKeyAction,
  removeEngineKeyAction,
}));

const { toastSuccess, toastError, refresh } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: toastSuccess, error: toastError } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

/** What one run of the current prompt set costs on each engine. */
const COST_PER_RUN: Record<EngineId, number> = { openai: 6.2, gemini: 1.7, anthropic: 2.3 };
/** What ONE call costs — the price of verifying, quoted before it happens. */
const COST_PER_CALL: Record<EngineId, number> = { openai: 0.252, gemini: 0.069, anthropic: 0.094 };

function row(overrides: Partial<EngineKeyRow> = {}): EngineKeyRow {
  return {
    engine: "openai",
    last4: "7f4A",
    status: "verified",
    enabled: true,
    verifiedAt: "2026-08-24T09:00:00Z",
    lastUsedAt: "2026-08-24T09:05:00Z",
    createdAt: "2026-08-24T08:00:00Z",
    createdByName: "Tomer",
    ...overrides,
  };
}

function card(props: Partial<Parameters<typeof AiEnginesCard>[0]> = {}) {
  return render(
    <AiEnginesCard
      keys={[]}
      costPerRun={COST_PER_RUN}
      costPerCall={COST_PER_CALL}
      isOwner
      {...props}
    />
  );
}

/** The block of markup for one engine, found by the heading text in its header. */
function engineRow(name: string): HTMLElement {
  const label = screen.getAllByText(name).find((node) => node.closest("div.space-y-2"));
  if (!label) throw new Error(`no row rendered for ${name}`);
  return label.closest("div.space-y-2") as HTMLElement;
}

/**
 * The row's switch, found INSIDE its row rather than by accessible name.
 *
 * Its `aria-label` is not the name a screen reader computes: Base UI's
 * `Switch.Root` is wrapped in a `<Label>`, which stamps `aria-labelledby` on
 * it, and `aria-labelledby` outranks `aria-label`. Querying by row is the
 * honest way to reach it without asserting a name the platform does not
 * actually produce — see the note in the report on the dead `aria-label`.
 */
function engineSwitch(name: string): HTMLElement {
  return within(engineRow(name)).getByRole("switch");
}

beforeEach(() => {
  vi.clearAllMocks();
  saveEngineKeyAction.mockResolvedValue({ ok: true, keys: [] });
  recheckEngineKeyAction.mockResolvedValue({ ok: true, keys: [] });
  toggleEngineKeyAction.mockResolvedValue({ ok: true, keys: [] });
  removeEngineKeyAction.mockResolvedValue({ ok: true, keys: [] });
});

afterEach(() => cleanup());

describe("the card always renders all three engines", () => {
  it("shows every engine even with no keys at all, so the empty state explains itself", () => {
    card();

    for (const name of ["ChatGPT", "Gemini", "Claude"]) {
      expect(engineRow(name)).toBeTruthy();
    }
    expect(screen.getAllByText("Not connected")).toHaveLength(3);
  });

  it("says whose money it is, and that BYOK does not cover the judge", () => {
    // Copy that implied otherwise would be a promise the next invoice
    // contradicts: BYOK moves the ENGINE share of the cost, not all of it.
    card();

    expect(screen.getByText(/billed to your accounts, not ours/i)).toBeInTheDocument();
    expect(screen.getByText(/Only the engine calls hit your keys/i)).toBeInTheDocument();
  });
});

describe("state: not connected", () => {
  it("renders no switch — there is nothing to enable", () => {
    // The contradictory combination is unreachable rather than discouraged.
    card();

    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });

  it("quotes the run price and the verification price BEFORE anything is spent", () => {
    card();

    const chatgpt = engineRow("ChatGPT");
    expect(within(chatgpt).getByText(/About \$6\.20 per run/)).toBeInTheDocument();
    // Two different numbers on purpose: verification is always exactly one
    // grounded call, whatever the prompt set and samples setting are.
    expect(within(chatgpt).getByText(/about \$0\.25 on your OpenAI account/i)).toBeInTheDocument();
  });

  it("names the trap almost nobody documents — a $0 balance passes every check", () => {
    card();

    expect(
      within(engineRow("ChatGPT")).getByText(/passes every check and then fails every call/i)
    ).toBeInTheDocument();
    // And the delegation affordance, which is the primary flow for a
    // three-person marketing team, not a nicety.
    expect(within(engineRow("ChatGPT")).getByText("Copy these steps")).toBeInTheDocument();
  });

  it("keeps the key field write-only — type=password, no autocomplete, no stored value", () => {
    card();

    const input = screen.getByLabelText("ChatGPT API key") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("off");
    // Nothing pre-filled, and nothing to pre-fill it from.
    expect(input.value).toBe("");
    expect(input.getAttribute("defaultValue")).toBeNull();
    // A `password` input with a stored value is the shape of a read-back path;
    // there is nothing on the server that could fill one.
    expect(input.getAttribute("value")).toBe("");
  });

  it("cannot submit an empty field", () => {
    card();

    expect(within(engineRow("ChatGPT")).getByRole("button", { name: "Connect" })).toBeDisabled();
  });
});

describe("the wrong-provider paste guard", () => {
  it("refuses an Anthropic key in the ChatGPT row without calling anything", () => {
    // Client-side, no API call. The alternative is spending the tenant's money
    // proving that an Anthropic key is not an OpenAI key.
    card();

    fireEvent.change(screen.getByLabelText("ChatGPT API key"), {
      target: { value: "sk-ant-api03-whatever" },
    });

    expect(screen.getByText(/Paste it in the Claude row instead/)).toBeInTheDocument();
    expect(within(engineRow("ChatGPT")).getByRole("button", { name: "Connect" })).toBeDisabled();
    expect(saveEngineKeyAction).not.toHaveBeenCalled();
  });

  it("refuses an `sk-` key in the Gemini row, and an org id anywhere", () => {
    card();

    fireEvent.change(screen.getByLabelText("Gemini API key"), {
      target: { value: "sk-proj-not-a-google-key" },
    });
    expect(screen.getByText(/Gemini keys start AIza/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Claude API key"), {
      target: { value: "org-8Xk2mQpL9v" },
    });
    expect(screen.getByText(/organization or project ID, not a secret key/)).toBeInTheDocument();
    expect(saveEngineKeyAction).not.toHaveBeenCalled();
  });

  it("lets a correctly-shaped key through, trimmed of the newline people paste", async () => {
    card();

    fireEvent.change(screen.getByLabelText("ChatGPT API key"), {
      target: { value: "sk-proj-a-real-looking-key" },
    });
    expect(screen.queryByText(/Paste it in the/)).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(engineRow("ChatGPT")).getByRole("button", { name: "Connect" }));
    });

    expect(saveEngineKeyAction).toHaveBeenCalledTimes(1);
    const posted = saveEngineKeyAction.mock.calls[0]![0];
    expect(posted.get("engine")).toBe("openai");
    expect(posted.get("key")).toBe("sk-proj-a-real-looking-key");
  });
});

describe("state: verified and in use", () => {
  it("shows the green indicator, the provenance line, and only the last four", () => {
    card({ keys: [row()] });

    const chatgpt = engineRow("ChatGPT");
    expect(within(chatgpt).getByText("Verified")).toBeInTheDocument();
    // Provenance — the industry blank. No surveyed product shows who pasted a
    // key, and a three-person team needs to know which colleague did.
    expect(within(chatgpt).getByText(/…7f4A · added 24 Aug by Tomer · checked 24 Aug · last used 24 Aug/))
      .toBeInTheDocument();
  });

  it("renders a switch that is on, because a verified key produced it", () => {
    card({ keys: [row()] });

    const toggle = engineSwitch("ChatGPT");
    expect(toggle).toBeEnabled();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("says a key that has never been spent has never been spent", () => {
    card({ keys: [row({ lastUsedAt: null })] });

    expect(within(engineRow("ChatGPT")).getByText(/never used yet/)).toBeInTheDocument();
  });
});

describe("state: verified but switched off — `Saved, not in use`", () => {
  it("is a distinct, named state rather than a missing badge", () => {
    // The copy that makes Remove and off legibly different. A team pausing
    // ChatGPT for a month must not think they have to mint a new key.
    card({ keys: [row({ enabled: false })] });

    const chatgpt = engineRow("ChatGPT");
    expect(within(chatgpt).getByText("Saved, not in use")).toBeInTheDocument();
    expect(
      within(chatgpt).getByText(/ChatGPT is not sampled and this key is not charged/)
    ).toBeInTheDocument();
    // Not priced, because it is not being spent.
    expect(within(chatgpt).queryByText(/per run at your current prompt set/)).not.toBeInTheDocument();
  });

  it("can be switched back on — off is one click, unlike Remove", async () => {
    card({ keys: [row({ enabled: false })] });

    const toggle = engineSwitch("ChatGPT");
    expect(toggle).toBeEnabled();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await act(async () => fireEvent.click(toggle));

    expect(toggleEngineKeyAction).toHaveBeenCalledWith("openai", true);
  });
});

describe("state: each failure badge", () => {
  // Decision 4: four states, never three. A badge that reads the same for two
  // causes tells a marketer to check two things and fix neither — Dify's bug.
  const cases: { status: EngineKeyStatus; badge: string; sentence: RegExp }[] = [
    { status: "invalid_key", badge: "Key rejected", sentence: /rejected this key/i },
    { status: "quota_exceeded", badge: "No credit", sentence: /has no credit/i },
    { status: "rate_limited", badge: "Rate-limited", sentence: /rate-limiting this key/i },
    { status: "provider_unavailable", badge: "Couldn't check", sentence: /Couldn't reach OpenAI/i },
    { status: "unreadable", badge: "Couldn't read key", sentence: /fault on our side/i },
  ];

  for (const testCase of cases) {
    it(`${testCase.status} reads as "${testCase.badge}" with its own remedy`, () => {
      card({ keys: [row({ status: testCase.status, enabled: false })] });

      const chatgpt = engineRow("ChatGPT");
      expect(within(chatgpt).getByText(testCase.badge)).toBeInTheDocument();
      expect(within(chatgpt).getByText(testCase.sentence)).toBeInTheDocument();
      // Never the green one at the same time.
      expect(within(chatgpt).queryByText("Verified")).not.toBeInTheDocument();
    });
  }

  it("gives all five states five different badges", () => {
    // The scannable half has to differ per state or the scan tells you nothing.
    const badges = new Set(cases.map((testCase) => testCase.badge));
    expect(badges.size).toBe(cases.length);
  });

  it("an out-of-credit key is sent to Re-check, NOT to pasting a replacement", () => {
    // The stored key is fine — it is the account that ran dry — and asking
    // someone to mint a replacement is asking them to do the one irreversible
    // thing on this card for no reason.
    card({ keys: [row({ status: "quota_exceeded", enabled: false })] });

    const chatgpt = engineRow("ChatGPT");
    expect(within(chatgpt).getByText(/press Re-check — the key itself is fine/)).toBeInTheDocument();
    expect(within(chatgpt).getByRole("button", { name: "Re-check" })).toBeEnabled();
  });

  it("cannot be switched ON while it is not verified", async () => {
    // The server enforces this too — this is the half a stale tab meets first.
    card({ keys: [row({ status: "invalid_key", enabled: false })] });

    const toggle = engineSwitch("ChatGPT");
    expect(toggle).toHaveAttribute("data-disabled");
    // Inert, not merely styled: clicking it must not post a state the server
    // would refuse anyway.
    await act(async () => fireEvent.click(toggle));
    expect(toggleEngineKeyAction).not.toHaveBeenCalled();
  });
});

describe("state: verifying", () => {
  it("every control says `Checking…` and refuses a second click while one is in flight", async () => {
    let release: (value: ActionResult) => void = () => {};
    saveEngineKeyAction.mockImplementation(
      () => new Promise<ActionResult>((resolve) => (release = resolve))
    );

    card();
    fireEvent.change(screen.getByLabelText("ChatGPT API key"), {
      target: { value: "sk-proj-good" },
    });
    const connect = within(engineRow("ChatGPT")).getByRole("button", { name: "Connect" });
    await act(async () => {
      fireEvent.click(connect);
    });

    const checking = within(engineRow("ChatGPT")).getByRole("button", { name: "Checking…" });
    expect(checking).toBeDisabled();

    await act(async () => {
      release({ ok: true, keys: [] });
    });
    // One call, not two — the paid grounded call must not be double-spent.
    expect(saveEngineKeyAction).toHaveBeenCalledTimes(1);
  });

  it("clears the field and refreshes on success, so the typed key does not linger", async () => {
    card();
    const input = screen.getByLabelText("ChatGPT API key") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-proj-good" } });

    await act(async () => {
      fireEvent.click(within(engineRow("ChatGPT")).getByRole("button", { name: "Connect" }));
    });

    expect(input.value).toBe("");
    expect(refresh).toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("ChatGPT connected");
  });

  it("surfaces the server's sentence on failure rather than a generic one", async () => {
    // The four sentences a tenant needs in order to fix their key are the whole
    // point of the discriminated union — a thrown Server Action error has its
    // message stripped in production.
    saveEngineKeyAction.mockResolvedValue({
      ok: false,
      error: "That key is valid, but the OpenAI account behind it has no credit.",
    });

    card();
    fireEvent.change(screen.getByLabelText("ChatGPT API key"), {
      target: { value: "sk-proj-broke" },
    });
    await act(async () => {
      fireEvent.click(within(engineRow("ChatGPT")).getByRole("button", { name: "Connect" }));
    });

    expect(toastError).toHaveBeenCalledWith(
      "That key is valid, but the OpenAI account behind it has no credit."
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("replace, and remove", () => {
  it("the replace field is write-only too, and promises the old key keeps working", () => {
    card({ keys: [row()] });

    const input = screen.getByLabelText("Replace the ChatGPT key") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    expect(
      screen.getByText(/The key you have now keeps working until the new one passes its check/)
    ).toBeInTheDocument();
  });

  it("replacing posts the new key to the same verify-before-store action", async () => {
    card({ keys: [row()] });

    fireEvent.change(screen.getByLabelText("Replace the ChatGPT key"), {
      target: { value: "sk-proj-the-replacement" },
    });
    await act(async () => {
      fireEvent.click(within(engineRow("ChatGPT")).getByRole("button", { name: "Replace" }));
    });

    const posted = saveEngineKeyAction.mock.calls[0]![0];
    expect(posted.get("key")).toBe("sk-proj-the-replacement");
    expect(toastSuccess).toHaveBeenCalledWith("ChatGPT key replaced");
  });

  it("Remove asks first, and says in the dialog that nobody can put it back", async () => {
    // The irreversibility IS the difference from the switch.
    card({ keys: [row()] });

    await act(async () => {
      fireEvent.click(within(engineRow("ChatGPT")).getByRole("button", { name: "Remove" }));
    });

    expect(screen.getByText("Remove the ChatGPT key?")).toBeInTheDocument();
    expect(
      screen.getByText(/Nobody can show you this key again — not us, and not OpenAI/)
    ).toBeInTheDocument();
    // The dialog names the key being destroyed by its last four, so nobody
    // removes the wrong one.
    expect(screen.getByText(/deletes the key ending …7f4A/)).toBeInTheDocument();
    // Nothing happened yet.
    expect(removeEngineKeyAction).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    });
    expect(removeEngineKeyAction).toHaveBeenCalledWith("openai");
  });
});

describe("owner-only, rendered honestly", () => {
  it("a member sees the state and can change nothing", () => {
    card({ isOwner: false, keys: [row(), row({ engine: "gemini", last4: "9ZZ2" })] });

    // Every status, every last-4 — masked state is visible to all members.
    expect(within(engineRow("ChatGPT")).getByText("Verified")).toBeInTheDocument();
    expect(within(engineRow("ChatGPT")).getByText(/…7f4A/)).toBeInTheDocument();
    expect(screen.getByText(/Only a workspace owner can add or change these keys/)).toBeInTheDocument();

    // …and not one control that writes.
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Re-check" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Replace" })).not.toBeInTheDocument();
    // No field to type a secret into at all.
    expect(screen.queryByLabelText("ChatGPT API key")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Replace the ChatGPT key")).not.toBeInTheDocument();
  });

  it("a member's switch is rendered but inert", async () => {
    // Honest rendering of a permission: the state is real and visible, the
    // control is not usable. Hiding the row would hide the fact that ChatGPT
    // is being measured on somebody's key.
    card({ isOwner: false, keys: [row()] });

    const toggle = engineSwitch("ChatGPT");
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute("data-disabled");
    await act(async () => fireEvent.click(toggle));
    expect(toggleEngineKeyAction).not.toHaveBeenCalled();
  });
});

describe("write-once, asserted at the DOM", () => {
  it("no rendered element anywhere carries more of a key than its last four", () => {
    // The real guarantee is the type: `EngineKeyRow` has no field that can hold
    // a plaintext key, so a component that wanted to render one could not find
    // it. This asserts the rendering matches — including the failure states,
    // where a careless implementation would echo "the key you sent was X".
    for (const status of [
      "verified",
      "invalid_key",
      "quota_exceeded",
      "rate_limited",
      "provider_unavailable",
      "unreadable",
    ] as EngineKeyStatus[]) {
      cleanup();
      card({ keys: [row({ status, enabled: status === "verified" })] });

      const markup = document.body.innerHTML;
      // Nothing that looks like a provider secret is in the document. The
      // placeholders are the deliberate exception and they are ellipses, not
      // keys — `sk-proj-…` has no key material in it.
      expect(markup).not.toMatch(/sk-proj-[A-Za-z0-9]/);
      expect(markup).not.toMatch(/sk-ant-[A-Za-z0-9]/);
      expect(markup).not.toMatch(/AIza[A-Za-z0-9]/);
      // The one fragment that is allowed, and only four characters of it.
      expect(markup).toContain("7f4A");
    }
  });

  it("nothing types a stored key back into an input, in any state", () => {
    card({
      keys: [
        row(),
        row({ engine: "gemini", last4: "9ZZ2", status: "invalid_key", enabled: false }),
        row({ engine: "anthropic", last4: "kk11", status: "unreadable", enabled: false }),
      ],
    });

    // Every field a secret could be typed into. The switch's own hidden
    // checkbox is excluded deliberately — it carries `value="on"`, which is the
    // form encoding of a boolean and not a place a key can hide.
    const secretFields = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="password"]')
    );
    expect(secretFields.length).toBeGreaterThan(0);
    for (const input of secretFields) {
      expect(input.value).toBe("");
    }
  });
});
