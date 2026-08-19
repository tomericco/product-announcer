"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveImagePolicy } from "./actions";
import type { BodyIllustrationSetting, ImagePolicy } from "@/db/schema";
import type { ContentType } from "@/lib/ai/compose-prompt";
import { BODY_SETTING_OPTIONS, DEFAULT_IMAGE_POLICY, IMAGE_POLICY_ROWS } from "@/lib/images/policy";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Entry = { cover: boolean; body: BodyIllustrationSetting };
type Matrix = Record<ContentType, Entry>;

// The Select works in strings; the setting is "off" | "auto" | 1 | 2 | 3.
const toValue = (b: BodyIllustrationSetting) => String(b);
const fromValue = (v: string): BodyIllustrationSetting => (v === "off" || v === "auto" ? v : (Number(v) as 1 | 2 | 3));

function fill(initial: ImagePolicy | null): Matrix {
  const out = { ...DEFAULT_IMAGE_POLICY } as Matrix;
  for (const row of IMAGE_POLICY_ROWS) {
    const entry = initial?.[row.type];
    if (entry) out[row.type] = entry;
  }
  return out;
}

/**
 * The Content images card (image spec §6): one row per content type, a cover
 * switch and a body-illustration cap. Saves the full matrix — the column is
 * one jsonb, and a row that matches the default is stored too, so a future
 * default change never silently flips a tenant's choice.
 */
export function ImagePolicyForm({ initial }: { initial: ImagePolicy | null }) {
  const [matrix, setMatrix] = useState<Matrix>(() => fill(initial));
  const [saving, setSaving] = useState(false);

  const set = (type: ContentType, patch: Partial<Entry>) => setMatrix((m) => ({ ...m, [type]: { ...m[type], ...patch } }));

  async function save() {
    setSaving(true);
    try {
      const res = await saveImagePolicy(matrix);
      if (res.ok) toast.success("Content image settings saved");
      else toast.error("Couldn't save content image settings");
    } catch {
      toast.error("Couldn't save content image settings — try again");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Type</th>
              <th className="py-2 pr-4 font-medium">Cover image</th>
              <th className="py-2 font-medium">Body images</th>
            </tr>
          </thead>
          <tbody>
            {IMAGE_POLICY_ROWS.map((row) => {
              const entry = matrix[row.type];
              const bodyLabel = BODY_SETTING_OPTIONS.find((o) => o.value === entry.body)?.label ?? String(entry.body);
              return (
                <tr key={row.type} className="border-t">
                  <td className="py-2 pr-4">{row.label}</td>
                  <td className="py-2 pr-4">
                    <Switch aria-label={`${row.label} cover image`} checked={entry.cover} onCheckedChange={(v) => set(row.type, { cover: v })} />
                  </td>
                  <td className="py-2">
                    <Select value={toValue(entry.body)} onValueChange={(v) => set(row.type, { body: fromValue(v as string) })}>
                      <SelectTrigger className="w-40" aria-label={`${row.label} body images`}>
                        <SelectValue>{bodyLabel}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {BODY_SETTING_OPTIONS.map((o) => (
                          <SelectItem key={String(o.value)} value={toValue(o.value)}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        Turning a type off stops new images from being generated for it; existing images stay.
      </p>
      <Button type="button" variant="outline" disabled={saving} onClick={save}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
