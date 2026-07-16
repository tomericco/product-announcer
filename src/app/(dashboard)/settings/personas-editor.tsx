"use client";

import { useState } from "react";
import type { Persona } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export function PersonasEditor({ personas: initial }: { personas: Persona[] }) {
  const [personas, setPersonas] = useState<Persona[]>(initial);

  const setField = (i: number, field: keyof Persona, value: string) =>
    setPersonas((ps) => ps.map((p, j) => (j === i ? { ...p, [field]: value } : p)));
  const add = () => setPersonas((ps) => [...ps, { name: "", usage: "", deliveredValue: "" }]);
  const remove = (i: number) => setPersonas((ps) => ps.filter((_, j) => j !== i));

  return (
    <div className="space-y-3">
      <input type="hidden" name="personas" value={JSON.stringify(personas)} />
      {personas.map((p, i) => (
        <div key={i} className="space-y-2 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <Label>Persona {i + 1}</Label>
            <Button type="button" variant="ghost" size="sm" onClick={() => remove(i)}>
              Remove
            </Button>
          </div>
          <Input placeholder="Name" value={p.name} onChange={(e) => setField(i, "name", e.target.value)} />
          <Textarea
            placeholder="How they should use the product"
            value={p.usage}
            onChange={(e) => setField(i, "usage", e.target.value)}
          />
          <Textarea
            placeholder="What they get from the product"
            value={p.deliveredValue}
            onChange={(e) => setField(i, "deliveredValue", e.target.value)}
          />
        </div>
      ))}
      {personas.length === 0 && <p className="text-sm text-muted-foreground">No personas yet.</p>}
      <Button type="button" variant="outline" size="sm" onClick={add}>
        Add persona
      </Button>
    </div>
  );
}
