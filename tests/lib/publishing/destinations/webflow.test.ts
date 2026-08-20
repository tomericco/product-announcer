import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { webflowDestination } from "../../../../src/lib/publishing/destinations/webflow";
import { db } from "../../../../src/db";
import { tenants, webflowConnections, type WebflowFieldMapping } from "../../../../src/db/schema";

// Token decryption is exercised in the credentials tests; stub it here so
// these cases stay focused on delivery behavior. `decryptSecret` is a vi.fn()
// (not a plain arrow function) so individual tests can override it for one
// call via mockImplementationOnce — see the decrypt-failure test below.
vi.mock("../../../../src/lib/credentials/encryption", () => ({
  encryptSecret: () => ({ ciphertext: "", iv: "", authTag: "" }),
  decryptSecret: vi.fn(() => "tok"),
}));

import { decryptSecret } from "../../../../src/lib/credentials/encryption";

// The cover reader hits Postgres for a real cover row; every case here uses
// a plain-object piece with a non-uuid id, so mock it and drive it per test.
vi.mock("../../../../src/lib/publishing/cover-image", () => ({ loadCoverImagePayload: vi.fn() }));
import { loadCoverImagePayload } from "../../../../src/lib/publishing/cover-image";

const SCHEMA = {
  id: "c1",
  displayName: "Blog",
  slug: "blog",
  fields: [
    { id: "f1", slug: "name", displayName: "Name", type: "PlainText", isRequired: true },
    { id: "f2", slug: "slug", displayName: "Slug", type: "PlainText", isRequired: true },
    { id: "f3", slug: "post-body", displayName: "Body", type: "RichText", isRequired: false },
    { id: "f4", slug: "main-image", displayName: "Main Image", type: "Image", isRequired: false },
  ],
};

const SCHEMA_REQUIRED_IMAGE = {
  ...SCHEMA,
  fields: SCHEMA.fields.map((f) => (f.slug === "main-image" ? { ...f, isRequired: true } : f)),
};

const mapping: WebflowFieldMapping = {
  name: { source: "title" },
  slug: { source: "slug" },
  "post-body": { source: "body" },
};

const mappingWithCover: WebflowFieldMapping = { ...mapping, "main-image": { source: "coverImage" } };

const COVER = { url: "https://blob.example/cover.png", alt: "Lighthouse over a grid", width: 1200, height: 630 };

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn1",
    tenantId: "t1",
    authType: "site_token",
    // Encrypted at rest; the destination decrypts before calling the API.
    tokenCiphertext: "",
    tokenIv: "",
    tokenAuthTag: "",
    siteId: "s1",
    collectionId: "c1",
    fieldMapping: mapping,
    publishMode: "draft",
    status: "active",
    ...overrides,
  } as never;
}

const update = {
  id: "u1",
  tenantId: "t1",
  title: "Faster Search",
  body: "We shipped search.",
  publishedAt: new Date("2026-07-20T10:00:00Z"),
} as never;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("webflowDestination.deliver", () => {
  beforeEach(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = "a".repeat(64);
    vi.stubGlobal("fetch", vi.fn());
    // restoreAllMocks() in the afterEach below resets decryptSecret's
    // mockImplementationOnce overrides but also clears its default
    // implementation (it's a bare vi.fn(), not a spy on a real module, so
    // "restore" has no original to fall back to) — reinstate the default
    // here so every test starts from a working decrypt.
    vi.mocked(decryptSecret).mockReturnValue("tok");
    vi.mocked(loadCoverImagePayload).mockReset();
    vi.mocked(loadCoverImagePayload).mockResolvedValue(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a draft item and returns its id", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(jsonResponse({ id: "item1" }, 202));

    const result = await webflowDestination.deliver(update, connection(), null, db);

    expect(result).toEqual({ status: "ok", externalId: "item1" });
    const [url, init] = vi.mocked(fetch).mock.calls[1];
    expect(url).toBe("https://api.webflow.com/v2/collections/c1/items");
    const body = JSON.parse(init?.body as string);
    expect(body.isDraft).toBe(true);
    expect(body.fieldData.name).toBe("Faster Search");
  });

  it("uses the live endpoint when publishMode is live", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(jsonResponse({ id: "item1" }, 202));

    await webflowDestination.deliver(update, connection({ publishMode: "live" }), null, db);

    expect(vi.mocked(fetch).mock.calls[1][0]).toBe("https://api.webflow.com/v2/collections/c1/items/live");
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string).isDraft).toBe(false);
  });

  it("never calls the site publish endpoint", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(jsonResponse({ id: "item1" }, 202));

    await webflowDestination.deliver(update, connection({ publishMode: "live" }), null, db);

    for (const [url] of vi.mocked(fetch).mock.calls) {
      expect(String(url)).not.toContain("/publish");
    }
  });

  it("patches the existing item when an externalId is known", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(jsonResponse({ id: "item1" }, 200));

    const result = await webflowDestination.deliver(update, connection(), "item1", db);

    expect(result.status).toBe("ok");
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe("https://api.webflow.com/v2/collections/c1/items/item1");
    expect(vi.mocked(fetch).mock.calls[1][1]?.method).toBe("PATCH");

    // The update path must never trigger a site-wide publish either: that
    // would deploy the customer's unrelated staged Designer changes.
    for (const [url] of vi.mocked(fetch).mock.calls) {
      expect(String(url)).not.toContain("/publish");
    }
  });

  it("falls back to create when the known item was deleted in Webflow", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404))
      .mockResolvedValueOnce(jsonResponse({ id: "item2" }, 202));

    const result = await webflowDestination.deliver(update, connection(), "item1", db);

    expect(result).toEqual({ status: "ok", externalId: "item2" });
  });

  it("uses the base slug (not a suffixed one) when falling back to create after a 404", async () => {
    // A 404-triggered switch from update to create is not a slug collision, so
    // it must not consume a slug-retry attempt or skip ahead to a suffixed slug.
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404))
      .mockResolvedValueOnce(jsonResponse({ id: "item2" }, 202));

    await webflowDestination.deliver(update, connection(), "item1", db);

    const createCall = vi.mocked(fetch).mock.calls[2];
    expect(createCall[0]).toBe("https://api.webflow.com/v2/collections/c1/items");
    expect(JSON.parse(createCall[1]?.body as string).fieldData.slug).toBe("faster-search");
  });

  it("retries with a suffixed slug on a slug collision", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            message: "Validation Error",
            code: "validation_error",
            details: [{ param: "slug", description: "Unique value is already in database: 'faster-search'" }],
          },
          400
        )
      )
      .mockResolvedValueOnce(jsonResponse({ id: "item1" }, 202));

    const result = await webflowDestination.deliver(update, connection(), null, db);

    expect(result.status).toBe("ok");
    expect(JSON.parse(vi.mocked(fetch).mock.calls[2][1]?.body as string).fieldData.slug).toBe("faster-search-2");
  });

  it("does not let a 404-triggered create consume the slug-collision budget", async () => {
    // The PATCH 404s (item was deleted in Webflow), so we fall back to create
    // at the SAME slug attempt. Every create after that collides. If the 404
    // wrongly consumed a slug-retry attempt, or `slugAttempt` were bumped
    // before the 404 branch runs, the slug budget would silently drop from 5
    // to 4 and the post-404 create would start at a suffix other than the
    // base slug. Assert the exact sequence of slugs sent to prove neither
    // happens.
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(SCHEMA));
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: "Not Found" }, 404));
    const collisionResponse = () =>
      jsonResponse(
        {
          message: "Validation Error",
          details: [{ param: "slug", description: "Unique value is already in database" }],
        },
        400
      );
    for (let i = 0; i < 5; i++) {
      vi.mocked(fetch).mockResolvedValueOnce(collisionResponse());
    }

    const result = await webflowDestination.deliver(update, connection(), "item1", db);

    expect(result.status).toBe("permanent");

    // calls[0] is the GET schema fetch; every call after that is an
    // item write (the PATCH, then five creates) and carries a JSON body
    // with fieldData.slug.
    const writeCalls = vi.mocked(fetch).mock.calls.slice(1);
    const slugsSent = writeCalls.map(([, init]) => JSON.parse((init as RequestInit).body as string).fieldData.slug);

    expect(slugsSent).toEqual(["faster-search", "faster-search", "faster-search-2", "faster-search-3", "faster-search-4", "faster-search-5"]);
  });

  it("gives up after exhausting slug attempts", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(SCHEMA));
    for (let i = 0; i < 5; i++) {
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse(
          {
            message: "Validation Error",
            details: [{ param: "slug", description: "Unique value is already in database" }],
          },
          400
        )
      );
    }
    const result = await webflowDestination.deliver(update, connection(), null, db);
    expect(result.status).toBe("permanent");
  });

  it("returns permanent on 401", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401));
    const result = await webflowDestination.deliver(update, connection(), null, db);
    expect(result).toMatchObject({ status: "permanent" });
  });

  it("returns permanent on a non-slug validation error, surfacing the detail", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(
        jsonResponse(
          { message: "Validation Error", details: [{ param: "author", description: "Field is required" }] },
          400
        )
      );
    const result = await webflowDestination.deliver(update, connection(), null, db);
    expect(result.status).toBe("permanent");
    expect((result as { error: string }).error).toContain("Field is required");
  });

  it("returns retryable on 429", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: "Too Many Requests" }, 429));
    expect((await webflowDestination.deliver(update, connection(), null, db)).status).toBe("retryable");
  });

  it("returns retryable on 5xx", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: "Server Error" }, 503));
    expect((await webflowDestination.deliver(update, connection(), null, db)).status).toBe("retryable");
  });

  it("returns retryable on 408", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: "Request Timeout" }, 408));
    expect((await webflowDestination.deliver(update, connection(), null, db)).status).toBe("retryable");
  });

  it("classifies a non-WebflowApiError (e.g. a request timeout) as retryable", async () => {
    // The Webflow client deliberately surfaces timeouts as plain Errors, not
    // WebflowApiError, so that classify()'s default-retryable branch catches
    // them. Simulate the underlying fetch rejecting the way `AbortSignal.timeout`
    // does, and confirm this layer still treats it as retryable rather than
    // falling into the permanent branch.
    const timeoutError = new Error("The operation was aborted due to timeout");
    timeoutError.name = "TimeoutError";
    vi.mocked(fetch).mockRejectedValueOnce(timeoutError);

    const result = await webflowDestination.deliver(update, connection(), null, db);

    expect(result.status).toBe("retryable");
  });

  it("returns permanent, not retryable, when the stored token cannot be decrypted, and never calls fetch", async () => {
    // A rotated/misconfigured CREDENTIALS_ENCRYPTION_KEY (or a corrupted row)
    // makes decryptSecret throw. That can't be fixed by retrying, so the sweep
    // must not classify it the same as a network error — it must never even
    // reach the network call. Mirrors webhook.ts's identical decrypt guard.
    vi.mocked(decryptSecret).mockImplementationOnce(() => {
      throw new Error("Unsupported state or unable to authenticate data");
    });

    const result = await webflowDestination.deliver(update, connection(), null, db);

    expect(result).toEqual({
      status: "permanent",
      error: "Could not decrypt the Webflow token. Check CREDENTIALS_ENCRYPTION_KEY.",
      // Config-shaped, not content-shaped: fixing CREDENTIALS_ENCRYPTION_KEY
      // makes this deliverable again, so dispatch.ts must not pin attempts to
      // the retry cap for it — see dispatch.test.ts's configFault coverage.
      configFault: true,
    });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("returns permanent for an empty body without calling Webflow", async () => {
    const result = await webflowDestination.deliver(
      { ...(update as Record<string, unknown>), body: "   " } as never,
      connection(),
      null,
      db
    );
    expect(result.status).toBe("permanent");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("returns permanent when the connection is not fully configured", async () => {
    const result = await webflowDestination.deliver(update, connection({ collectionId: null }), null, db);
    expect(result.status).toBe("permanent");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("returns permanent when a required field mapped to title is blank, without writing the item", async () => {
    // Only the schema fetch happens; the item-write call must never fire once
    // a required field's mapped value is known to be empty.
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(SCHEMA));

    const blankTitleUpdate = { ...(update as Record<string, unknown>), title: "   " };
    const result = await webflowDestination.deliver(blankTitleUpdate as never, connection(), null, db);

    expect(result).toEqual({
      status: "permanent",
      error: 'Webflow requires "Name", but the mapped value is empty.',
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://api.webflow.com/v2/collections/c1");
  });

  it("publishes normally when a required field's mapped value is present", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(jsonResponse({ id: "item9" }, 202));

    const result = await webflowDestination.deliver(update, connection(), null, db);

    expect(result).toEqual({ status: "ok", externalId: "item9" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("sends { url, alt } for the coverImage-mapped field when the piece has a ready cover", async () => {
    vi.mocked(loadCoverImagePayload).mockResolvedValue(COVER);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(jsonResponse({ id: "item1" }, 202));

    const result = await webflowDestination.deliver(update, connection({ fieldMapping: mappingWithCover }), null, db);

    expect(result).toEqual({ status: "ok", externalId: "item1" });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string);
    expect(body.fieldData["main-image"]).toEqual({ url: "https://blob.example/cover.png", alt: "Lighthouse over a grid" });
    expect(loadCoverImagePayload).toHaveBeenCalledWith("t1", "u1", db);
  });

  it("omits the image key (no null) when the piece has no cover and the field is optional", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(jsonResponse({ id: "item1" }, 202));

    const result = await webflowDestination.deliver(update, connection({ fieldMapping: mappingWithCover }), null, db);

    expect(result.status).toBe("ok");
    const body = JSON.parse(vi.mocked(fetch).mock.calls[1][1]?.body as string);
    expect(body.fieldData).not.toHaveProperty("main-image");
  });

  it("returns a clear permanent error when a REQUIRED image field is mapped to coverImage and the piece has no cover", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(SCHEMA_REQUIRED_IMAGE));

    const result = await webflowDestination.deliver(update, connection({ fieldMapping: mappingWithCover }), null, db);

    expect(result).toEqual({
      status: "permanent",
      error: 'Webflow requires "Main Image", but the mapped value is empty.',
    });
    // Schema fetch only; the item write must never fire.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("does not read the cover row at all when the mapping has no coverImage entry", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(jsonResponse({ id: "item1" }, 202));

    await webflowDestination.deliver(update, connection(), null, db);

    expect(loadCoverImagePayload).not.toHaveBeenCalled();
  });
});

describe("webflowDestination.deliver — needs_reauth status writes", () => {
  const TENANT_NAME = "Webflow Deliver Status Test Tenant";

  beforeEach(() => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = "a".repeat(64);
    vi.stubGlobal("fetch", vi.fn());
    // See the identical comment in the describe block above: restoreAllMocks()
    // clears decryptSecret's default implementation, so it must be reinstated
    // before every test.
    vi.mocked(decryptSecret).mockReturnValue("tok");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await db.delete(tenants).where(eq(tenants.name, TENANT_NAME));
  });

  // A real row is required here (unlike the plain-object cast used above):
  // these tests assert on a write to that row, which only exists in the
  // database, not on a `deliver`-local object.
  async function seedConnection(overrides: Partial<typeof webflowConnections.$inferInsert> = {}) {
    const [tenant] = await db.insert(tenants).values({ name: TENANT_NAME }).returning();
    const [connection] = await db
      .insert(webflowConnections)
      .values({
        tenantId: tenant.id,
        tokenCiphertext: "x",
        tokenIv: "x",
        tokenAuthTag: "x",
        siteId: "s1",
        collectionId: "c1",
        fieldMapping: mapping,
        publishMode: "draft",
        status: "active",
        ...overrides,
      })
      .returning();
    return connection;
  }

  async function statusOf(connectionId: string) {
    const [row] = await db.select().from(webflowConnections).where(eq(webflowConnections.id, connectionId));
    return row.status;
  }

  it("sets the connection to needs_reauth on a 401 and still returns permanent", async () => {
    const connection = await seedConnection();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401));

    const result = await webflowDestination.deliver(update, connection, null, db);

    expect(result).toMatchObject({ status: "permanent" });
    expect(await statusOf(connection.id)).toBe("needs_reauth");
  });

  it("sets the connection to needs_reauth on a 403 and still returns permanent", async () => {
    const connection = await seedConnection();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: "Forbidden" }, 403));

    const result = await webflowDestination.deliver(update, connection, null, db);

    expect(result).toMatchObject({ status: "permanent" });
    expect(await statusOf(connection.id)).toBe("needs_reauth");
  });

  it("does not change status on a 400 validation error — that is a content problem, not an auth problem", async () => {
    const connection = await seedConnection();
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(SCHEMA))
      .mockResolvedValueOnce(
        jsonResponse(
          { message: "Validation Error", details: [{ param: "author", description: "Field is required" }] },
          400
        )
      );

    const result = await webflowDestination.deliver(update, connection, null, db);

    expect(result.status).toBe("permanent");
    expect(await statusOf(connection.id)).toBe("active");
  });

  it("still returns the permanent result, without throwing, when recording needs_reauth itself fails", async () => {
    const connection = await seedConnection();
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401));

    const brokenDb = {
      update: () => {
        throw new Error("db write failed");
      },
    } as unknown as typeof db;

    await expect(webflowDestination.deliver(update, connection, null, brokenDb)).resolves.toMatchObject({
      status: "permanent",
    });
  });
});
