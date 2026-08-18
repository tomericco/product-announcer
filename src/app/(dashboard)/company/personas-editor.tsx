"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { savePersonas } from "./actions";
import { useUnsavedChanges } from "../unsaved-changes";
import type { PersonaRef } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type SystemPersona = { key: string; name: string; description: string };

export function PersonasEditor({
  personas: initial,
  catalog,
}: {
  personas: PersonaRef[];
  catalog: SystemPersona[];
}) {
  const [personas, setPersonas] = useState<PersonaRef[]>(initial);
  const [open, setOpen] = useState(false);
  // What the server last accepted, so the Save buttons can tell edited personas
  // from untouched ones. Adding and removing persist immediately and advance
  // this; typing in a custom persona's fields does not, until its Save.
  const [saved, setSaved] = useState<PersonaRef[]>(initial);
  const [saving, setSaving] = useState(false);
  const { setSectionDirty } = useUnsavedChanges();

  const dirty = JSON.stringify(personas) !== JSON.stringify(saved);

  // No page-level Save covers this card any more, so unsaved custom-persona text
  // would otherwise be lost silently on navigation. Report it to the shared
  // guard, which prompts before leaving.
  useEffect(() => {
    setSectionDirty("personas", dirty);
  }, [dirty, setSectionDirty]);

  // Clear the flag on unmount so a stale warning can't stay armed on another page.
  useEffect(() => () => setSectionDirty("personas", false), [setSectionDirty]);

  const byKey = new Map(catalog.map((c) => [c.key, c]));
  const usedKeys = new Set(personas.flatMap((p) => (p.type === "system" ? [p.key] : [])));
  const available = catalog.filter((c) => !usedKeys.has(c.key));

  // Adding and removing a persona persists immediately; edits to a custom
  // persona's Name and Brief wait for its own Save button. Either way the whole
  // list is written, since it lives in one JSON column -- so an add or remove
  // also flushes any pending text edits sitting alongside it.
  // `notify` is on only for the Save button. Add and remove write silently --
  // the list changing on screen is its own confirmation, and toasting every
  // click would be noise. Failures speak up either way.
  const persist = async (next: PersonaRef[], notify = false) => {
    setSaving(true);
    try {
      await savePersonas(next);
      // Only advance the baseline once the server accepted it, so a failed save
      // leaves the card dirty and the Save buttons live.
      setSaved(next);
      if (notify) toast.success("Personas saved");
    } catch {
      // The list on screen already shows the change, so a silent failure would
      // be indistinguishable from success.
      toast.error("Couldn't save personas — try again");
    } finally {
      setSaving(false);
    }
  };

  const remove = (i: number) => {
    const next = personas.filter((_, j) => j !== i);
    setPersonas(next);
    persist(next);
  };

  const setCustomField = (i: number, field: "name" | "brief", value: string) =>
    setPersonas((ps) =>
      ps.map((p, j) => {
        if (j !== i || p.type !== "custom") return p;
        return field === "name" ? { ...p, name: value } : { ...p, brief: value };
      })
    );

  const addSystem = (key: string) => {
    const next: PersonaRef[] = [...personas, { type: "system", key }];
    setPersonas(next);
    setOpen(false);
    persist(next);
  };
  const addCustom = () => {
    // Deliberately not persisted: the new row has an empty name, which the
    // server's sanitizePersonas drops, so the write would be a no-op. It lands
    // once the name is filled in and the persona's own Save is pressed.
    setPersonas((ps) => [...ps, { type: "custom", name: "", brief: "" }]);
    setOpen(false);
  };

  return (
    <div className="space-y-3">
      {/* No hidden input: this card is no longer inside a form. It writes through
          the savePersonas Server Action on add, remove, and its own Save. */}
      {personas.map((p, i) => (
        <div key={i} className="space-y-2 rounded-md border p-3">
          {p.type === "system" ? (
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{byKey.get(p.key)?.name ?? p.key}</span>
                  <Badge variant="secondary">Built-in</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{byKey.get(p.key)?.description ?? ""}</p>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => remove(i)}>
                Remove
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Custom persona</Label>
                <Button type="button" variant="ghost" size="sm" onClick={() => remove(i)}>
                  Remove
                </Button>
              </div>
              <Input
                placeholder="Name"
                value={p.name}
                onChange={(e) => setCustomField(i, "name", e.target.value)}
              />
              <Textarea
                placeholder="Brief: their interest in updates, what's in it for them, and what not to emphasize"
                rows={3}
                value={p.brief}
                onChange={(e) => setCustomField(i, "brief", e.target.value)}
              />
              {/* Saves the whole list, not just this persona -- they share one
                  JSON column. Disabled while clean so the button means something:
                  if it's live, there is genuinely something unwritten. */}
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!dirty || saving}
                  onClick={() => persist(personas, true)}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}

      {personas.length === 0 && <p className="text-xs text-muted-foreground">No personas yet.</p>}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger
          render={
            <Button type="button" variant="outline" size="sm">
              <Plus />
              Add persona
            </Button>
          }
        />
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a persona</DialogTitle>
            <DialogDescription>
              Pick a built-in persona, or create your own.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {available.length > 0 ? (
              <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {available.map((c) => (
                  <li key={c.key}>
                    <button
                      type="button"
                      onClick={() => addSystem(c.key)}
                      className="flex w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left hover:bg-muted/50"
                    >
                      <span className="text-sm font-medium">{c.name}</span>
                      <span className="text-xs text-muted-foreground">{c.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">All built-in personas have been added.</p>
            )}
            <Button type="button" variant="outline" className="w-full" onClick={addCustom}>
              <Plus />
              Add custom persona
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
