import { describe, it, expect } from "vitest";
import { readDraftProgress } from "../../../src/lib/scheduling/read-draft-progress";
import type { DraftProgressEvent } from "../../../src/lib/scheduling/draft-progress";

/** Builds a stream that emits the given raw chunks in order, so a test can
 * split NDJSON lines across chunk boundaries on purpose. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("readDraftProgress", () => {
  it("delivers one event per NDJSON line, in order", async () => {
    const seen: DraftProgressEvent[] = [];
    await readDraftProgress(
      streamOf([
        '{"type":"step","key":"preparing","status":"start"}\n',
        '{"type":"step","key":"preparing","status":"done"}\n',
        '{"type":"done","updateId":"r1"}\n',
      ]),
      (e) => seen.push(e)
    );
    expect(seen).toEqual([
      { type: "step", key: "preparing", status: "start" },
      { type: "step", key: "preparing", status: "done" },
      { type: "done", updateId: "r1" },
    ]);
  });

  it("reassembles a line split across chunk boundaries", async () => {
    const seen: DraftProgressEvent[] = [];
    await readDraftProgress(
      streamOf(['{"type":"detail","tex', 't":"Reviewing (round 1)"}\n']),
      (e) => seen.push(e)
    );
    expect(seen).toEqual([{ type: "detail", text: "Reviewing (round 1)" }]);
  });

  it("delivers a trailing line that has no newline terminator", async () => {
    const seen: DraftProgressEvent[] = [];
    await readDraftProgress(streamOf(['{"type":"error","message":"boom"}']), (e) => seen.push(e));
    expect(seen).toEqual([{ type: "error", message: "boom" }]);
  });

  it("ignores blank lines", async () => {
    const seen: DraftProgressEvent[] = [];
    await readDraftProgress(
      streamOf(['\n{"type":"done","updateId":"r1"}\n\n']),
      (e) => seen.push(e)
    );
    expect(seen).toEqual([{ type: "done", updateId: "r1" }]);
  });
});
