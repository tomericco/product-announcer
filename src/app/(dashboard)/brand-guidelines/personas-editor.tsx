"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
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

  const byKey = new Map(catalog.map((c) => [c.key, c]));
  const usedKeys = new Set(personas.flatMap((p) => (p.type === "system" ? [p.key] : [])));
  const available = catalog.filter((c) => !usedKeys.has(c.key));

  const remove = (i: number) => setPersonas((ps) => ps.filter((_, j) => j !== i));

  const setCustomField = (i: number, field: "name" | "brief", value: string) =>
    setPersonas((ps) =>
      ps.map((p, j) => {
        if (j !== i || p.type !== "custom") return p;
        return field === "name" ? { ...p, name: value } : { ...p, brief: value };
      })
    );

  const addSystem = (key: string) => {
    setPersonas((ps) => [...ps, { type: "system", key }]);
    setOpen(false);
  };
  const addCustom = () => {
    setPersonas((ps) => [...ps, { type: "custom", name: "", brief: "" }]);
    setOpen(false);
  };

  return (
    <div className="space-y-3">
      <input type="hidden" name="personas" value={JSON.stringify(personas)} />

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
