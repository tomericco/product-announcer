/**
 * The nearest heading above the live caret, read from the editor DOM. Scopes
 * "Suggest prompt" to the section being written; null when the caret is above
 * the first heading, or not inside `.mdx-content` at all.
 *
 * DOM-reading, not markdown-reading, on purpose: MDXEditor exposes no markdown
 * offset for the caret, so the heading TEXT is the only handle the client can
 * hand the server (which then slices with `sliceAroundHeading`).
 *
 * Deliberately importless — it is imported by a jsdom test that must not pull
 * a server module (and therefore `@/db`) into the graph.
 */
export function nearestHeadingAbove(root: Document | null = typeof document === "undefined" ? null : document): string | null {
  const sel = root?.getSelection?.() ?? null;
  const anchor = sel?.anchorNode ?? null;
  if (!anchor) return null;
  const el = anchor instanceof Element ? anchor : anchor.parentElement;
  const content = el?.closest(".mdx-content") ?? null;
  if (!el || !content || el === content) return null;
  let block: Element | null = el;
  while (block && block.parentElement !== content) block = block.parentElement;
  for (let n = block?.previousElementSibling ?? null; n; n = n.previousElementSibling) {
    if (/^H[1-6]$/.test(n.tagName)) return n.textContent?.trim() || null;
  }
  return null;
}
