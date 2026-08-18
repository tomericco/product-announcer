import type { systemContentExamples } from "@/db/schema";

export type ExampleRow = typeof systemContentExamples.$inferSelect;

export type ExampleCriteria = {
  industry: string | null;
  personaKeys: string[];
  // A blog prompt must never see changelog exemplars, so content type is a hard
  // filter rather than a ranking signal like industry and persona.
  contentType: ExampleRow["contentType"];
  categories?: string[];
};

function score(example: ExampleRow, criteria: ExampleCriteria): number {
  const industryMatch =
    example.industry !== null &&
    criteria.industry !== null &&
    example.industry.toLowerCase() === criteria.industry.toLowerCase();
  const personaMatch = example.personaKey !== null && criteria.personaKeys.includes(example.personaKey);
  return (industryMatch ? 1 : 0) + (personaMatch ? 1 : 0);
}

function categoryMatch(example: ExampleRow, criteria: ExampleCriteria): boolean {
  // category is null for blog and social exemplars — those never match.
  return example.category !== null && (criteria.categories ?? []).includes(example.category);
}

/**
 * Strict, capped few-shot selection. An example is a candidate only if its
 * content type matches the request AND it matches the tenant's industry OR one
 * of their system persona keys. Candidates are ranked by match strength (both
 * tags > one tag), then by whether the example's category is one the batch is
 * about, then by sort_order ascending. Top `limit` returned; no candidates →
 * empty array.
 */
export function selectExamples(
  examples: ExampleRow[],
  criteria: ExampleCriteria,
  limit = 3
): ExampleRow[] {
  return examples
    .filter((example) => example.contentType === criteria.contentType)
    .map((example) => ({ example, s: score(example, criteria), c: categoryMatch(example, criteria) }))
    .filter((candidate) => candidate.s > 0)
    .sort(
      (a, b) =>
        b.s - a.s ||
        Number(b.c) - Number(a.c) ||
        a.example.sortOrder - b.example.sortOrder
    )
    .slice(0, limit)
    .map((candidate) => candidate.example);
}
