"use client";

import { useState } from "react";
import { toast } from "sonner";
import { saveWebflowMapping } from "./actions";
import type { WebflowCollectionDetail } from "@/lib/integrations/webflow/client";
import type { WebflowFieldMapping } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SOURCE_OPTIONS = [
  { value: "title", label: "Update title" },
  { value: "body", label: "Update body" },
  { value: "slug", label: "Slug" },
  { value: "publishedAt", label: "Published date" },
  { value: "static", label: "Static value" },
  { value: "empty", label: "Leave empty" },
];

const PUBLISH_MODE_OPTIONS = [
  { value: "draft", label: "Create as draft" },
  { value: "live", label: "Publish live" },
];

function labelFor(options: { value: string; label: string }[], value: string) {
  return options.find((o) => o.value === value)?.label ?? value;
}

function initialSource(mapping: WebflowFieldMapping, slug: string): string {
  const entry = mapping[slug];
  if (!entry) return "empty";
  return entry.source;
}

function initialStatic(mapping: WebflowFieldMapping, slug: string): string {
  const entry = mapping[slug];
  return entry && entry.source === "static" ? entry.value : "";
}

export function WebflowMappingForm({
  collection,
  mapping,
  publishMode,
}: {
  collection: WebflowCollectionDetail;
  mapping: WebflowFieldMapping;
  publishMode: string;
}) {
  const [sources, setSources] = useState<Record<string, string>>(() =>
    Object.fromEntries(collection.fields.map((field) => [field.slug, initialSource(mapping, field.slug)]))
  );
  // Controlled, like `sources` above — the static-value Input is only
  // conditionally mounted (shown when its field's source is "static"), so an
  // uncontrolled `defaultValue` would forget anything typed the moment the
  // Select switches away and back and the input remounts.
  const [staticValues, setStaticValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(collection.fields.map((field) => [field.slug, initialStatic(mapping, field.slug)]))
  );
  const [mode, setMode] = useState(publishMode);
  const [submitting, setSubmitting] = useState(false);

  // A collection with no fields has nothing to map. Saving anyway would
  // create blank CMS items at publish time, and the sibling pickers
  // (WebflowSiteForm, WebflowCollectionForm) already refuse their own empty
  // case the same way.
  if (collection.fields.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This collection has no fields, so there is nothing to map. Choose a different collection above.
      </p>
    );
  }

  async function handleSave(formData: FormData) {
    setSubmitting(true);
    // saveWebflowMapping returns { ok: false, error } when validateMapping
    // finds an unmapped required field — rendering that here is what makes
    // the block actionable; a thrown error's message is stripped in a
    // production build before it would reach this catch.
    const result = await saveWebflowMapping(formData);
    if (result.ok) {
      toast.success("Webflow field mapping saved");
    } else {
      toast.error(result.error);
    }
    setSubmitting(false);
  }

  return (
    <form action={handleSave} className="space-y-4">
      <div className="space-y-4">
        {collection.fields.map((field) => (
          <div key={field.slug} className="space-y-2 rounded-lg border border-border p-3">
            <Label>
              {field.displayName}
              {field.isRequired && <span className="text-destructive"> *</span>}
            </Label>
            <Select
              name={`source:${field.slug}`}
              value={sources[field.slug]}
              onValueChange={(value) =>
                setSources((prev) => ({ ...prev, [field.slug]: value as string }))
              }
            >
              <SelectTrigger>
                <SelectValue>{labelFor(SOURCE_OPTIONS, sources[field.slug])}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SOURCE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {sources[field.slug] === "static" && (
              <div className="space-y-1">
                <Label htmlFor={`static-${field.slug}`} className="sr-only">
                  Static value for {field.displayName}
                </Label>
                <Input
                  id={`static-${field.slug}`}
                  name={`static:${field.slug}`}
                  value={staticValues[field.slug] ?? ""}
                  onChange={(event) =>
                    setStaticValues((prev) => ({ ...prev, [field.slug]: event.target.value }))
                  }
                  placeholder="Static value"
                />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="space-y-2">
        <Label>Publish mode</Label>
        <Select name="publishMode" value={mode} onValueChange={(value) => setMode(value as string)}>
          <SelectTrigger>
            <SelectValue>{labelFor(PUBLISH_MODE_OPTIONS, mode)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PUBLISH_MODE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button type="submit" variant="outline" disabled={submitting}>
        {submitting ? "Saving…" : "Save mapping"}
      </Button>
    </form>
  );
}
