import type { systemUpdateExamples } from "../db/schema";

export type ExampleRow = typeof systemUpdateExamples.$inferSelect;

export type ExampleCriteria = { industry: string | null; personaKeys: string[] };

function score(example: ExampleRow, criteria: ExampleCriteria): number {
  const industryMatch =
    example.industry !== null &&
    criteria.industry !== null &&
    example.industry.toLowerCase() === criteria.industry.toLowerCase();
  const personaMatch = example.personaKey !== null && criteria.personaKeys.includes(example.personaKey);
  return (industryMatch ? 1 : 0) + (personaMatch ? 1 : 0);
}

/**
 * Strict, capped few-shot selection. An example is a candidate only if it matches
 * the tenant's industry OR one of their system persona keys. Candidates are ranked
 * by match strength (both tags > one tag), ties broken by sort_order ascending, and
 * the top `limit` are returned. No candidates → empty array.
 */
export function selectExamples(
  examples: ExampleRow[],
  criteria: ExampleCriteria,
  limit = 3
): ExampleRow[] {
  return examples
    .map((example) => ({ example, s: score(example, criteria) }))
    .filter((c) => c.s > 0)
    .sort((a, b) => b.s - a.s || a.example.sortOrder - b.example.sortOrder)
    .slice(0, limit)
    .map((c) => c.example);
}
