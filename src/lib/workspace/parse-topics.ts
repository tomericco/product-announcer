/**
 * Splits a topics textarea on commas and newlines. Deduplicates case-insensitively
 * because "AI agents" and "ai agents" would otherwise both reach the news agent's
 * search in spec 4 and pay for the same query twice.
 */
export function parseTopics(raw: string): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const part of raw.split(/[,\n]/)) {
    const topic = part.trim();
    if (!topic) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
  }
  return topics;
}
