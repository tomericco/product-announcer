import type { DraftProgressEvent } from "./draft-progress";

/**
 * Reads an NDJSON progress stream from one of the pipeline routes, calling
 * `handle` once per event. Chunk boundaries fall anywhere, so a partial line is
 * buffered until its newline arrives, and a final line without a terminator is
 * still delivered.
 *
 * The compose dialog (`draft-release-dialog.tsx`) deliberately does NOT use
 * this: its loop checks an abort signal between chunks and awaits an async
 * paced-apply per event. Keep that one separate rather than growing options
 * here for a single caller.
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
