import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webhookDestination } from "../../../../src/lib/publishing/destinations/webhook";
import type { ContentPiece, DbClient } from "../../../../src/lib/publishing/destinations/types";

vi.mock("../../../../src/lib/publishing/cover-image", () => ({ loadCoverImagePayload: vi.fn() }));
import { loadCoverImagePayload } from "../../../../src/lib/publishing/cover-image";

const piece = (over: Partial<ContentPiece> = {}): ContentPiece =>
  ({
    id: "p1",
    tenantId: "t1",
    title: "New Dashboard",
    body: "Hello ![Alt](https://blob.example/x.png)",
    status: "published",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    publishedAt: new Date("2026-08-02T00:00:00Z"),
    ...over,
  }) as ContentPiece;

// No secret: unsigned delivery, no decrypt path.
const config = { id: "w1", tenantId: "t1", url: "https://example.com/hook", active: true } as never;

// deliver() never touches the DB itself; the cover reader is mocked above.
const database = {} as DbClient;

describe("webhook destination payload", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true } as Response));
    vi.mocked(loadCoverImagePayload).mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends coverImage: null when the piece has no cover", async () => {
    vi.mocked(loadCoverImagePayload).mockResolvedValue(null);

    const result = await webhookDestination.deliver(piece(), config, null, database);

    expect(result).toEqual({ status: "ok" });
    const [, init] = vi.mocked(fetch).mock.calls[0];
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.coverImage).toBeNull();
    expect(Object.keys(payload).sort()).toEqual(
      ["body", "coverImage", "createdAt", "id", "publishedAt", "status", "tenantId", "title"].sort()
    );
    expect(loadCoverImagePayload).toHaveBeenCalledWith("t1", "p1", database);
  });

  it("sends coverImage with url, alt, width and height when the piece has a ready cover", async () => {
    vi.mocked(loadCoverImagePayload).mockResolvedValue({
      url: "https://blob.example/cover.png",
      alt: "A lighthouse over a grid",
      width: 1200,
      height: 630,
    });

    await webhookDestination.deliver(piece(), config, null, database);

    const [, init] = vi.mocked(fetch).mock.calls[0];
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.coverImage).toEqual({
      url: "https://blob.example/cover.png",
      alt: "A lighthouse over a grid",
      width: 1200,
      height: 630,
    });
  });
});
