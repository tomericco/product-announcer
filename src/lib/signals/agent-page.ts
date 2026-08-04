import { createHash } from "node:crypto";
import { fetchPageText, type PageResult } from "../workspace/fetch-page";

export type Block = { hash: string; text: string; title: string };

type FetchPage = (url: string) => Promise<PageResult>;

// A block needs enough text to be worth surfacing as a signal. HTML-extracted
// text carries nav/footer remnants ("Pricing", "Sign in", "© 2026 Rival Inc")
// that are well under this -- a genuine changelog line ("Added SAML SSO for
// every plan.") clears it comfortably.
const MIN_BLOCK_LENGTH = 30;
// Bounds the work extractBlocks does (and the size of what a later task would
// diff/store) against a pathological page that is one giant run of paragraphs.
const MAX_BLOCKS = 500;
const HEADING_RE = /^#{1,6}\s/;

/**
 * Looks for a machine-readable version of a competitor's page before settling
 * for whatever HTML crawling turns up. Tries, in order, stopping at the first
 * success: the page's own `.md` variant (skipped when the URL already ends in
 * `.md` or `.txt` -- appending `.md` to an already agent-facing URL makes no
 * sense), then `{origin}/llms.txt`, then `{origin}/llms-full.txt`. At most
 * three requests total -- every probe is a real HTTP request against a third
 * party, so this must stay bounded.
 */
export async function probeAgentPage(
  pageUrl: string,
  deps: { fetchPage?: FetchPage } = {}
): Promise<string | null> {
  const fetchPage = deps.fetchPage ?? fetchPageText;

  let origin: string;
  let alreadyAgentFacing: boolean;
  try {
    const url = new URL(pageUrl);
    origin = url.origin;
    alreadyAgentFacing = /\.(md|txt)$/i.test(url.pathname);
  } catch {
    return null;
  }

  const candidates: string[] = [];
  if (!alreadyAgentFacing) candidates.push(`${pageUrl}.md`);
  candidates.push(`${origin}/llms.txt`);
  candidates.push(`${origin}/llms-full.txt`);

  for (const candidate of candidates) {
    const result = await fetchPage(candidate);
    if (!("error" in result)) return candidate;
  }
  return null;
}

/**
 * Splits a chunk's lines at markdown headings, so "## First\nbody\n## Second"
 * becomes two blocks even without a blank line separating them. A heading at
 * the very start of the chunk doesn't split -- it just opens the first block.
 */
function splitAtHeadings(lines: string[]): string[][] {
  const result: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (HEADING_RE.test(line) && current.length > 0) {
      result.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

/**
 * Splits page text into hashed, title-bearing blocks. Pure and synchronous --
 * no fetching, no knowledge of sources, no deduplication against a prior run
 * (that's the agent's job in a later task). This is the unit of change for a
 * design with no RSS feeds and therefore no entry boundaries or dates: a
 * "block that wasn't there last time" stands in for a changelog entry.
 *
 * Every line is right-trimmed before hashing. Without that, a competitor
 * re-indenting or adding trailing spaces would flip every block's hash and
 * flood the signals browser with a page's worth of false "new" blocks.
 */
export function extractBlocks(text: string): Block[] {
  const trimmedLines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/, ""));
  const paragraphs = trimmedLines.join("\n").split(/\n{2,}/);

  const blocks: Block[] = [];
  for (const paragraph of paragraphs) {
    if (blocks.length >= MAX_BLOCKS) break;
    const chunks = splitAtHeadings(paragraph.split("\n"));
    for (const chunk of chunks) {
      if (blocks.length >= MAX_BLOCKS) break;
      const blockText = chunk.join("\n").trim();
      if (blockText.length < MIN_BLOCK_LENGTH) continue;
      const hash = createHash("sha256").update(blockText).digest("hex");
      const title = blockText.split("\n")[0].slice(0, 120);
      blocks.push({ hash, text: blockText, title });
    }
  }
  return blocks;
}
