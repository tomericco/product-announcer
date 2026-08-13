import type { DraftProgressEvent } from "./draft-progress";

/**
 * Reads an NDJSON progress stream from one of the pipeline routes, calling
 * `handle` once per event. Chunk boundaries fall anywhere, so a partial line is
 * buffered until its newline arrives, and a final line without a terminator is
 * still delivered.
 *
 * Deliberately no abort-signal handling or paced/throttled apply here — a
 * caller that needs those (e.g. to keep each step visible for a minimum time,
 * or to cancel mid-stream) should wrap this rather than growing options here
 * for a single caller.
 */
export async function readDraftProgress(
  body: ReadableStream<Uint8Array>,
  handle: (event: DraftProgressEvent) => void
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) handle(JSON.parse(line) as DraftProgressEvent);
  }
  if (buffer.trim()) handle(JSON.parse(buffer) as DraftProgressEvent);
}
