import type { WebflowFieldMapping } from "@/db/schema";
import { markdownToWebflowHtml } from "@/lib/publishing/markdown-to-html";
import { slugify } from "@/lib/publishing/slug";
import type { ContentPiece } from "@/lib/publishing/destinations/types";
import type { WebflowField } from "./client";

export function buildFieldData(
  piece: ContentPiece,
  mapping: WebflowFieldMapping,
  fields: WebflowField[],
  slugOverride?: string
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  for (const field of fields) {
    const entry = mapping[field.slug];
    if (!entry || entry.source === "empty") continue;

    switch (entry.source) {
      case "title":
        data[field.slug] = piece.title;
        break;
      case "body":
        data[field.slug] = markdownToWebflowHtml(piece.body);
        break;
      case "slug":
        data[field.slug] = slugOverride ?? slugify(piece.title);
        break;
      case "publishedAt":
        // Webflow DateTime fields take ISO-8601. Fall back to now for an update
        // that has not been stamped yet.
        data[field.slug] = (piece.publishedAt ?? new Date()).toISOString();
        break;
      case "static":
        data[field.slug] = entry.value;
        break;
    }
  }

  // Iterating `fields` rather than `mapping` means a mapping entry for a field
  // deleted in Webflow is silently ignored here; validateMapping surfaces it.
  return data;
}

export function validateMapping(mapping: WebflowFieldMapping, fields: WebflowField[]): string[] {
  const problems: string[] = [];
  const knownSlugs = new Set(fields.map((f) => f.slug));

  for (const field of fields) {
    if (!field.isRequired) continue;
    const entry = mapping[field.slug];
    if (!entry || entry.source === "empty") {
      problems.push(`"${field.displayName}" is required by Webflow but is not mapped.`);
      continue;
    }
    if (entry.source === "static" && !entry.value.trim()) {
      problems.push(`"${field.displayName}" is set to a static value but the value is blank.`);
    }
  }

  for (const slug of Object.keys(mapping)) {
    if (!knownSlugs.has(slug)) {
      problems.push(`Mapped field "${slug}" no longer exists in this collection.`);
    }
  }

  return problems;
}

export function suggestMapping(fields: WebflowField[]): WebflowFieldMapping {
  const suggestion: WebflowFieldMapping = {};
  let richTextTaken = false;
  let dateTaken = false;

  for (const field of fields) {
    if (field.slug === "name") {
      suggestion.name = { source: "title" };
    } else if (field.slug === "slug") {
      suggestion.slug = { source: "slug" };
    } else if (field.type === "RichText" && !richTextTaken) {
      // Only the first: a second rich text field is usually an excerpt, and
      // duplicating the whole body into it is worse than leaving it blank.
      suggestion[field.slug] = { source: "body" };
      richTextTaken = true;
    } else if (field.type === "DateTime" && !dateTaken) {
      suggestion[field.slug] = { source: "publishedAt" };
      dateTaken = true;
    }
  }

  return suggestion;
}
