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
  const [mode, setMode] = useState(publishMode);
  const [submitting, setSubmitting] = useState(false);

  async function handleSave(formData: FormData) {
    setSubmitting(true);
    try {
      await saveWebflowMapping(formData);
      toast.success("Webflow field mapping saved");
    } catch (error) {
      // saveWebflowMapping throws when validateMapping finds an unmapped
      // required field — surface that message instead of letting the thrown
      // server action fall through to Next.js's unstyled error page.
      toast.error(error instanceof Error ? error.message : "Could not save the field mapping");
    } finally {
      setSubmitting(false);
    }
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
                  defaultValue={initialStatic(mapping, field.slug)}
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
