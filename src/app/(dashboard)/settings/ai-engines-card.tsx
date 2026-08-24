"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ConnectedIndicator } from "../integrations/connected-indicator";
import { ENGINE_NAME, ENGINE_ORDER } from "../ai-visibility/engine-labels";
import type { EngineId } from "@/lib/ai-visibility/types";
import type { EngineKeyStatus } from "@/lib/ai-visibility/engine-keys";
import { engineKeyMessage } from "./engine-key-copy";
import {
  recheckEngineKeyAction,
  removeEngineKeyAction,
  saveEngineKeyAction,
  toggleEngineKeyAction,
} from "./engine-key-actions";

/**
 * "AI engines" — the BYOK card, and the ONLY place an engine can be switched on.
 *
 * ### Why it is here and not on Integrations
 *
 * A credential belongs on the general Integrations surface when it connects an
 * external SYSTEM several features may draw on; it belongs in feature settings
 * when it is an input parameter to ONE feature's behaviour. Five of five
 * products that actually ship LLM BYOK attach the credential to the AI feature;
 * none put it on a general integrations page. The sharper predictor, found
 * across eight devtool vendors: OAuth connections go to a central page, pasted
 * secrets end up on the consuming feature's own settings screen. Ours are
 * pasted secrets for one feature, which puts them here twice over.
 *
 * Named "AI engines" rather than "Credentials", "API keys" or "BYOK" — of 18
 * products with a dedicated credential screen, the provider-named variants are
 * the only ones that name something a marketer recognises.
 *
 * ### Why the switch lives in this row
 *
 * "Is ChatGPT part of my measurement?" and "do we have a working ChatGPT key?"
 * are the same question. Two controls for one decision is a contradiction
 * waiting to be rendered, so the engine switches moved OUT of the schedule form
 * and into these rows. No product in the survey ships the split we were
 * considering; five co-locate key and toggle in one row.
 *
 * The structural idea taken from VS Code: **the toggle only exists over an
 * engine a verified key already produced.** A keyless row renders no switch at
 * all, so "switched on with nothing to answer for it" is unreachable rather
 * than merely discouraged.
 *
 * ### All three always rendered
 *
 * Including the ones with no key — that is what makes the empty state explain
 * itself instead of being an empty card.
 */

export type EngineKeyRow = {
  engine: EngineId;
  last4: string;
  status: EngineKeyStatus;
  enabled: boolean;
  verifiedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  createdByName: string | null;
};

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function on(value: string | null): string | null {
  return value ? DATE.format(new Date(value)) : null;
}

/**
 * The per-provider "how do I get one" steps.
 *
 * Step 2 is the one that matters and almost nobody documents it — Zapier is the
 * only surveyed product that warns about it. A new key with a $0 balance passes
 * every check ever written and then fails every call, which is exactly the
 * failure the paid half of our own verification exists to catch.
 *
 * Step 1 exists for a different trap: platform.openai.com is a DIFFERENT
 * account from ChatGPT, and the person who has a ChatGPT Plus subscription and
 * no platform account is the exact person this feature confuses.
 */
const KEY_STEPS: Record<EngineId, { url: string; steps: string[] }> = {
  openai: {
    url: "https://platform.openai.com/api-keys",
    steps: [
      "Go to platform.openai.com/api-keys and sign in. This is a different account from ChatGPT.",
      "Add a payment method under Billing and top up about $10. A new key with a $0 balance passes every check and then fails every call — this step is not optional.",
      "Click Create new secret key, name it “Versional”.",
      "Copy it and paste it above. OpenAI shows it once.",
    ],
  },
  gemini: {
    url: "https://aistudio.google.com/apikey",
    steps: [
      "Go to aistudio.google.com/apikey and sign in with the Google account that owns your Cloud project.",
      "Create an API key, and link it to a project with billing enabled. Grounded answers are not covered by the free tier.",
      "Copy the key — it starts AIza — and paste it above.",
    ],
  },
  anthropic: {
    url: "https://console.anthropic.com/settings/keys",
    steps: [
      "Go to console.anthropic.com/settings/keys and sign in. This is a different account from Claude.ai.",
      "Buy about $10 of credit under Billing first. A key on an account with no credit fails every call.",
      "Create a key, name it “Versional”, and set its expiry to Never — Anthropic keys can be created with a 30-day expiry, and Anthropic emails the key's creator, not us, when one dies.",
      "Copy it and paste it above. Anthropic shows it once.",
    ],
  },
};

/** Client-side, no API call. The server repeats these — see `wrongProviderHint`. */
function misdirectedPaste(engine: EngineId, key: string): string | null {
  if (engine !== "anthropic" && key.startsWith("sk-ant-")) {
    return "That looks like an Anthropic key. Paste it in the Claude row instead.";
  }
  if (engine !== "gemini" && key.startsWith("AIza")) {
    return "That looks like a Google AI key. Paste it in the Gemini row instead.";
  }
  if (engine === "gemini" && key.startsWith("sk-")) {
    return "That looks like an OpenAI or Anthropic key. Gemini keys start AIza.";
  }
  if (key.startsWith("org-") || key.startsWith("proj_")) {
    return "That's an organization or project ID, not a secret key.";
  }
  return null;
}

const PLACEHOLDER: Record<EngineId, string> = {
  openai: "sk-proj-…",
  gemini: "AIza…",
  anthropic: "sk-ant-…",
};

/** Provider names, for the sentences about whose invoice this is. */
const PROVIDER: Record<EngineId, string> = {
  openai: "OpenAI",
  gemini: "Google",
  anthropic: "Anthropic",
};

export function AiEnginesCard({
  keys,
  costPerRun,
  costPerCall,
  isOwner,
}: {
  keys: EngineKeyRow[];
  /** What one run of the tenant's CURRENT prompt set costs on each engine. */
  costPerRun: Record<EngineId, number>;
  /**
   * What ONE call costs — the price of verifying, quoted before it happens.
   *
   * A separate number from `costPerRun` and not derivable from it: the run
   * figure scales with the prompt set and the samples setting, and
   * verification is always exactly one grounded call whatever those are.
   */
  costPerCall: Record<EngineId, number>;
  /**
   * Decision 8: owner-only for writes, masked state visible to all members.
   * A member sees every row, every status and every last-4 and can change
   * nothing — which is the honest rendering of a permission, not a hidden card.
   */
  isOwner: boolean;
}) {
  const byEngine = new Map(keys.map((row) => [row.engine, row]));

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Engine answers are collected with your own provider keys and billed to your accounts, not ours.
        An engine with no key is not measured.
      </p>
      {!isOwner && (
        <p className="text-sm text-muted-foreground">
          Only a workspace owner can add or change these keys.
        </p>
      )}
      {ENGINE_ORDER.map((engine) => (
        <EngineRow
          key={engine}
          engine={engine}
          row={byEngine.get(engine) ?? null}
          costPerRun={costPerRun[engine] ?? 0}
          costPerCall={costPerCall[engine] ?? 0}
          isOwner={isOwner}
        />
      ))}
      {/* Said here rather than left to be discovered on an invoice: BYOK moves
          the ENGINE share of the cost, not all of it. Copy that implied
          otherwise would be a promise the next bill contradicts. */}
      <p className="text-sm text-muted-foreground">
        Reading and scoring the answers runs on Versional&apos;s own AI and is included in your plan. Only
        the engine calls hit your keys.
      </p>
    </div>
  );
}

function EngineRow({
  engine,
  row,
  costPerRun,
  costPerCall,
  isOwner,
}: {
  engine: EngineId;
  row: EngineKeyRow | null;
  costPerRun: number;
  costPerCall: number;
  isOwner: boolean;
}) {
  const [key, setKey] = useState("");
  const [pending, startTransition] = useTransition();
  const [removeOpen, setRemoveOpen] = useState(false);
  const router = useRouter();

  const name = ENGINE_NAME[engine];
  const provider = PROVIDER[engine];
  const pasteWarning = key.trim().length > 0 ? misdirectedPaste(engine, key.trim()) : null;

  function run(action: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setKey("");
        setRemoveOpen(false);
        toast.success(success);
        router.refresh();
      } else {
        toast.error(result.error ?? "Something went wrong.");
      }
    });
  }

  // ---- Not connected -------------------------------------------------------
  // No switch is rendered. There is nothing to enable, and a switch over
  // nothing is the contradictory state this design makes unreachable.
  if (!row) {
    return (
      <div className="space-y-2 border-t pt-4 first:border-t-0 first:pt-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">{name}</span>
          <Badge variant="outline">Not connected</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          About ${costPerRun.toFixed(2)} per run at your current prompt set, billed by {provider} to your
          key.
        </p>
        {isOwner && (
          <>
            <div className="flex flex-wrap gap-2">
              <Label htmlFor={`key-${engine}`} className="sr-only">
                {name} API key
              </Label>
              {/* Write-only: never rendered back with a defaultValue, and there
                  is no read-back path to render one from. */}
              <Input
                id={`key-${engine}`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                className="w-full sm:w-80"
                placeholder={PLACEHOLDER[engine]}
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
              <Button
                variant="outline"
                disabled={pending || key.trim().length === 0 || pasteWarning !== null}
                onClick={() => {
                  const data = new FormData();
                  data.set("engine", engine);
                  data.set("key", key);
                  run(() => saveEngineKeyAction(data), `${name} connected`);
                }}
              >
                {pending ? "Checking…" : "Connect"}
              </Button>
            </div>
            {pasteWarning && <p className="text-xs text-destructive">{pasteWarning}</p>}
            <p className="text-xs text-muted-foreground">
              Connecting runs one real question on this key to prove it works — about $
              {costPerCall.toFixed(2)} on your {provider} account. A key that only passes a login check
              can still fail every call.
            </p>
            <HowToGetAKey engine={engine} />
          </>
        )}
      </div>
    );
  }

  // ---- Connected (in any state) --------------------------------------------
  const verified = row.status === "verified";
  const provenance = [
    `…${row.last4}`,
    row.createdByName ? `added ${on(row.createdAt)} by ${row.createdByName}` : `added ${on(row.createdAt)}`,
    row.verifiedAt ? `checked ${on(row.verifiedAt)}` : null,
    row.lastUsedAt ? `last used ${on(row.lastUsedAt)}` : "never used yet",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-2 border-t pt-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* The accessible name is the LABEL's text, not an `aria-label` on the
            switch. Base UI's `Switch.Root` detects the wrapping `<label>` and
            stamps `aria-labelledby` on itself, and `aria-labelledby` outranks
            `aria-label` — so the `aria-label={`Use ${name}`}` that used to be
            here computed to nothing at all, and a screen reader read the switch
            as "ChatGPT".

            Keeping the wrapper is what makes clicking the engine name toggle
            the switch, so the fix is to put the verb in the label instead of
            fighting it: the "Use " is visually hidden and the name is not, so
            the row still reads "ChatGPT" and the control announces "Use
            ChatGPT, switch, on". */}
        <Label className="text-sm font-medium">
          {/* The switch exists only because a verified key produced it. A
              non-verified row keeps the switch — it is still the tenant's — but
              cannot be switched ON, which the server enforces too. */}
          <Switch
            checked={row.enabled}
            disabled={!isOwner || pending || (!row.enabled && !verified)}
            onCheckedChange={(checked) =>
              run(
                () => toggleEngineKeyAction(engine, checked),
                checked ? `${name} in use` : `${name} saved, not in use`
              )
            }
          />
          {/* The separator is a real text node, and it is load-bearing: the
              accessible-name algorithm concatenates each element's contribution
              without inserting one, so `<span>Use</span><span>ChatGPT</span>`
              computes to "UseChatGPT". A whitespace-only child of a flex
              container is not rendered, so it costs nothing visually. */}
          <span className="sr-only">Use</span>{" "}
          {/* Its own element, not a bare text node: the row is found by this
              text, and a bare node would fold into the label's own text. */}
          <span>{name}</span>
        </Label>
        {verified ? (
          <ConnectedIndicator label={row.enabled ? "Verified" : "Saved, not in use"} />
        ) : (
          <Badge variant="destructive">{STATUS_BADGE[row.status]}</Badge>
        )}
      </div>

      <p className="text-xs text-muted-foreground">{provenance}</p>

      {/* Named as the state it is, in words, rather than left to the badge —
          "Saved, not in use" is the sentence that makes Remove and off legibly
          different, and Raycast states the consequence in the row. */}
      {verified && !row.enabled && (
        <p className="text-xs text-muted-foreground">
          Saved, not in use. {name} is not sampled and this key is not charged.
        </p>
      )}
      {!verified && <p className="text-xs text-destructive">{engineKeyMessage(engine, row.status)}</p>}
      {verified && row.enabled && (
        <p className="text-xs text-muted-foreground">
          About ${costPerRun.toFixed(2)} per run at your current prompt set, billed by {provider} to your
          key.
        </p>
      )}

      {isOwner && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => run(() => recheckEngineKeyAction(engine), `${name} key checked`)}
          >
            {pending ? "Checking…" : "Re-check"}
          </Button>

          <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
            <DialogTrigger render={<Button variant="ghost" disabled={pending} />}>Remove</DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Remove the {name} key?</DialogTitle>
                {/* Said plainly, because it is true and nothing else on this
                    card is irreversible: the providers each show a secret
                    exactly once, so nobody — including us — can put this back.
                    That irreversibility IS the difference from the switch. */}
                <DialogDescription>
                  This deletes the key ending …{row.last4} and switches {name} off. Nobody can show you
                  this key again — not us, and not {provider} — so coming back means creating a new one.
                  Everything already measured is kept.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" disabled={pending} />}>Cancel</DialogClose>
                <Button
                  variant="destructive"
                  disabled={pending}
                  onClick={() => run(() => removeEngineKeyAction(engine), `${name} key removed`)}
                >
                  {pending ? "Removing…" : "Remove key"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}

      {isOwner && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Replace this key</summary>
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap gap-2">
              <Label htmlFor={`replace-${engine}`} className="sr-only">
                Replace the {name} key
              </Label>
              <Input
                id={`replace-${engine}`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                className="w-full sm:w-80"
                placeholder={PLACEHOLDER[engine]}
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
              <Button
                variant="outline"
                disabled={pending || key.trim().length === 0 || pasteWarning !== null}
                onClick={() => {
                  const data = new FormData();
                  data.set("engine", engine);
                  data.set("key", key);
                  run(() => saveEngineKeyAction(data), `${name} key replaced`);
                }}
              >
                {pending ? "Checking…" : "Replace"}
              </Button>
            </div>
            {pasteWarning && <p className="text-destructive">{pasteWarning}</p>}
            {/* The old key stays in place until the new one passes both checks,
                so a bad paste cannot take a working engine down. */}
            <p className="text-muted-foreground">
              The key you have now keeps working until the new one passes its check.
            </p>
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * Short badge text per non-verified status.
 *
 * Four distinct states, never collapsed. The full sentence is rendered under
 * the row — the badge is the scannable half, and it has to be different per
 * state or the scan tells you nothing.
 */
const STATUS_BADGE: Record<EngineKeyStatus, string> = {
  verified: "Verified",
  invalid_key: "Key rejected",
  quota_exceeded: "No credit",
  rate_limited: "Rate-limited",
  provider_unavailable: "Couldn't check",
  unreadable: "Couldn't read key",
};

/**
 * The delegation affordance, and it is the PRIMARY flow rather than a nicety.
 *
 * 0 of 12 marketing products surveyed support delegating key entry, and the
 * realistic path for a three-person marketing team is forwarding instructions
 * to whoever owns the provider account. HubSpot comes closest by naming the
 * provider-side role required, which is a delegation prompt in disguise.
 */
function HowToGetAKey({ engine }: { engine: EngineId }) {
  const { url, steps } = KEY_STEPS[engine];
  const name = ENGINE_NAME[engine];
  const provider = PROVIDER[engine];

  async function copySteps() {
    const text = [
      `Please create a ${provider} API key for our Versional workspace:`,
      ...steps.map((step, index) => `${index + 1}. ${step}`),
      `Then send it back to me and I'll paste it in — ${url}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Steps copied");
    } catch {
      toast.error("Couldn't copy — select the steps and copy them by hand.");
    }
  }

  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">How to get a {provider} key</summary>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="mt-2 text-muted-foreground">
        Not your job?{" "}
        <button type="button" onClick={copySteps} className="underline underline-offset-2">
          Copy these steps
        </button>{" "}
        and send them to whoever owns your {provider} account. {name} answers are billed to that account.
      </p>
    </details>
  );
}
