import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../../src/db";
import {
  tenants,
  repos,
  contentPieces,
  webhookConfigs,
  webflowConnections,
  deliveryAttempts,
  type WebflowFieldMapping,
} from "../../../src/db/schema";
import { dispatchAllDestinations, retryFailedDeliveries, listPublishTargets } from "../../../src/lib/publishing/dispatch";
import { encryptSecret } from "../../../src/lib/credentials/encryption";

const SECRET = "s3cr3t";
const encryptedSecret = () => {
  const p = encryptSecret(SECRET);
  return { secretCiphertext: p.ciphertext, secretIv: p.iv, secretAuthTag: p.authTag };
};

const encryptedToken = () => {
  const p = encryptSecret("wf-tok");
  return { tokenCiphertext: p.ciphertext, tokenIv: p.iv, tokenAuthTag: p.authTag };
};

const WEBFLOW_SCHEMA = {
  id: "c1",
  displayName: "Blog",
  slug: "blog",
  fields: [{ id: "f1", slug: "name", displayName: "Name", type: "PlainText", isRequired: true }],
};

const webflowMapping: WebflowFieldMapping = { name: { source: "title" } };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("dispatch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.delete(tenants).where(eq(tenants.name, "Webhook Delivery Test Tenant"));
  });

  async function seed() {
    const [tenant] = await db.insert(tenants).values({ name: "Webhook Delivery Test Tenant" }).returning();
    const [repo] = await db
      .insert(repos)
      .values({ tenantId: tenant.id, githubRepoFullName: "acme/x", githubInstallationId: "1", watchedBranch: "main" })
      .returning();
    const [update] = await db
      .insert(contentPieces)
      .values({
        tenantId: tenant.id,
        repoId: repo.id,
        title: "T",
        body: "B",
        status: "published",
      })
      .returning();
    return { tenant, repo, update };
  }

  it("records a successful delivery and signs the payload", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });

    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await dispatchAllDestinations(update.id);

    const [call] = vi.mocked(fetch).mock.calls;
    expect(call[0]).toBe("https://example.com/hook");
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-product-announcer-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    // Asserts the exact payload shape (rather than naming the retired field
    // directly) so the legacy composition column can't silently reappear here.
    const payload = JSON.parse((call[1] as RequestInit).body as string);
    expect(Object.keys(payload).sort()).toEqual(
      ["body", "coverImage", "createdAt", "id", "publishedAt", "status", "tenantId", "title"].sort()
    );
    // The seeded piece has no cover row: the key is present, the value null.
    expect(payload.coverImage).toBeNull();

    const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(delivery.status).toBe("success");
    expect(delivery.attempts).toBe(1);
  });

  it("delivers without a signature header when the webhook config has no secret", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook" });

    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await dispatchAllDestinations(update.id);

    const [call] = vi.mocked(fetch).mock.calls;
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-product-announcer-signature"]).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");

    const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(delivery.status).toBe("success");
  });

  it("records a failed delivery without throwing when the endpoint errors", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });

    vi.mocked(fetch).mockRejectedValue(new Error("timeout"));

    await expect(dispatchAllDestinations(update.id)).resolves.not.toThrow();

    const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(delivery.status).toBe("failed");
  });

  it("does nothing when the tenant has no active webhook config", async () => {
    const { update } = await seed();

    await dispatchAllDestinations(update.id);

    const deliveries = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(deliveries).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("treats a Webflow connection with no collection chosen yet as not-a-destination", async () => {
    // A connection row is created as soon as a token validates, before the
    // wizard's site/collection steps are done — that half-finished state is
    // deliberate and resumable. Without gating loadConfig on collectionId,
    // this row would be treated as a live destination: deliver() would
    // return permanent for "missing a collection", dispatch would pin
    // attempts to MAX_ATTEMPTS, and the sweep would skip it forever — even
    // after the user finishes the wizard and the connection becomes usable.
    const { tenant, update } = await seed();
    await db.insert(webflowConnections).values({
      tenantId: tenant.id,
      ...encryptedToken(),
      status: "active",
      // siteId/collectionId intentionally left null: wizard not finished.
    });

    await dispatchAllDestinations(update.id);

    const deliveries = await db
      .select()
      .from(deliveryAttempts)
      .where(and(eq(deliveryAttempts.contentPieceId, update.id), eq(deliveryAttempts.destination, "webflow")));
    expect(deliveries).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("listPublishTargets reports configured=true only for destinations that are ready", async () => {
    const { tenant } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });
    // Webflow connection exists but no collection chosen yet → not a usable target.
    await db.insert(webflowConnections).values({ tenantId: tenant.id, ...encryptedToken(), status: "active" });

    const targets = await listPublishTargets(tenant.id);

    expect(targets).toEqual([
      { id: "webhook", label: "Webhook", configured: true },
      { id: "webflow", label: "Webflow", configured: false },
      { id: "linkedin", label: "LinkedIn", configured: false },
    ]);
  });

  it("listPublishTargets reports Webflow configured once a collection is picked", async () => {
    const { tenant } = await seed();
    await db.insert(webflowConnections).values({
      tenantId: tenant.id, ...encryptedToken(), siteId: "s1", collectionId: "c1",
      fieldMapping: webflowMapping, publishMode: "draft", status: "active",
    });

    const targets = await listPublishTargets(tenant.id);

    expect(targets).toEqual([
      { id: "webhook", label: "Webhook", configured: false },
      { id: "webflow", label: "Webflow", configured: true },
      { id: "linkedin", label: "LinkedIn", configured: false },
    ]);
  });

  it("dispatchAllDestinations with `only` delivers to just the listed destinations", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });
    await db.insert(webflowConnections).values({
      tenantId: tenant.id, ...encryptedToken(), siteId: "s1", collectionId: "c1",
      fieldMapping: webflowMapping, publishMode: "draft", status: "active",
    });

    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await dispatchAllDestinations(update.id, db, ["webhook"]);

    const deliveries = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(deliveries.map((d) => d.destination)).toEqual(["webhook"]);
    // Webflow untouched: its delivery would be 2 fetches (schema + create); webhook is 1.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("dispatchAllDestinations with no `only` delivers to all configured destinations", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });
    await db.insert(webflowConnections).values({
      tenantId: tenant.id, ...encryptedToken(), siteId: "s1", collectionId: "c1",
      fieldMapping: webflowMapping, publishMode: "draft", status: "active",
    });

    // Registry order is [webhook, webflow]: webhook = 1 fetch, webflow = schema + create.
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce(jsonResponse(WEBFLOW_SCHEMA))
      .mockResolvedValueOnce(jsonResponse({ id: "item1" }, 202));

    await dispatchAllDestinations(update.id, db);

    const deliveries = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(deliveries.map((d) => d.destination).sort()).toEqual(["webflow", "webhook"]);
  });

  it("dispatchAllDestinations with `only` naming an unconfigured destination delivers nothing", async () => {
    const { update } = await seed();

    await dispatchAllDestinations(update.id, db, ["webflow"]);

    const deliveries = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(deliveries).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retryFailedDeliveries retries failed deliveries under the attempt cap", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() }).returning();
    await db.insert(deliveryAttempts).values({
      contentPieceId: update.id,
      destination: "webhook",
      status: "failed",
      attempts: 1,
    });

    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await retryFailedDeliveries();

    const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(delivery.status).toBe("success");
    expect(delivery.attempts).toBe(2);
  });

  it("retryFailedDeliveries retries a failed Webflow delivery under the attempt cap", async () => {
    // retryFailedDeliveries was generalized from webhook-only to loop over all
    // registered destinations. Every other test in this describe block only
    // seeds a webhook row, so nothing proves the sweep actually reaches the
    // Webflow destination. This test is that proof.
    const { tenant, update } = await seed();
    await db.insert(webflowConnections).values({
      tenantId: tenant.id,
      ...encryptedToken(),
      siteId: "s1",
      collectionId: "c1",
      fieldMapping: webflowMapping,
      publishMode: "draft",
      status: "active",
    });
    await db.insert(deliveryAttempts).values({
      contentPieceId: update.id,
      destination: "webflow",
      status: "failed",
      attempts: 1,
    });

    // A successful Webflow delivery is two fetch calls: fetch the collection
    // schema, then create (or update) the item.
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(WEBFLOW_SCHEMA)).mockResolvedValueOnce(jsonResponse({ id: "item1" }, 202));

    await retryFailedDeliveries();

    const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(delivery.status).toBe("success");
    expect(delivery.attempts).toBe(2);
    expect(delivery.externalId).toBe("item1");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retryFailedDeliveries skips deliveries that already hit the attempt cap", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() }).returning();
    await db.insert(deliveryAttempts).values({
      contentPieceId: update.id,
      destination: "webhook",
      status: "failed",
      attempts: 3,
    });

    await retryFailedDeliveries();

    expect(fetch).not.toHaveBeenCalled();
  });

  it("dispatchAllDestinations never throws, even if a DB operation fails", async () => {
    const { update } = await seed();

    // A database whose first query throws simulates a DB error mid-dispatch.
    // Publish already committed before dispatch runs, so dispatch must swallow
    // this rather than propagate a 500 out of approveDraft.
    const brokenDb = {
      select: () => {
        throw new Error("db connection lost");
      },
    } as unknown as typeof db;

    await expect(dispatchAllDestinations(update.id, brokenDb)).resolves.not.toThrow();
  });

  it("retryFailedDeliveries skips deliveries whose config was deactivated", async () => {
    const { tenant, update } = await seed();
    await db
      .insert(webhookConfigs)
      .values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret(), active: false })
      .returning();
    await db.insert(deliveryAttempts).values({
      contentPieceId: update.id,
      destination: "webhook",
      status: "failed",
      attempts: 1,
    });

    await retryFailedDeliveries();

    expect(fetch).not.toHaveBeenCalled();
    const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBe(1);
  });

  it("resets the retry budget on a fresh publish instead of accumulating across re-publishes", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });

    // Publish while the endpoint is down: attempts starts at 1, not accumulated.
    vi.mocked(fetch).mockRejectedValue(new Error("timeout"));
    await dispatchAllDestinations(update.id);

    let [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBe(1);

    // Sweep it to exhaustion: 1 -> 2 -> 3.
    await retryFailedDeliveries();
    await retryFailedDeliveries();

    [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBe(3);

    // A further sweep must skip it now that it's exhausted.
    await retryFailedDeliveries();
    expect(fetch).toHaveBeenCalledTimes(3); // the original publish + the 2 sweeps above

    // The operator fixes the endpoint and re-publishes, but it fails once more
    // transiently. Without the fix, this would push attempts to 4 and the row
    // would never be retried again.
    await dispatchAllDestinations(update.id);

    [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBe(1);

    // And it's eligible for the sweep again: this call must actually retry it.
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    await retryFailedDeliveries();

    [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(delivery.status).toBe("success");
    expect(delivery.attempts).toBe(2);
  });

  it("classifies a webhook secret decrypt failure as permanent and never calls fetch", async () => {
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({
      tenantId: tenant.id,
      url: "https://example.com/hook",
      // Not a valid ciphertext for the configured CREDENTIALS_ENCRYPTION_KEY, so
      // decryptSecret throws.
      secretCiphertext: "not-valid-ciphertext",
      secretIv: "not-valid-iv",
      secretAuthTag: "not-valid-auth-tag",
    });

    await dispatchAllDestinations(update.id);

    expect(fetch).not.toHaveBeenCalled();

    const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(delivery.status).toBe("failed");
    // A decrypt failure is config-shaped (rotating CREDENTIALS_ENCRYPTION_KEY
    // back fixes it), so it must not pin attempts to MAX_ATTEMPTS the way a
    // genuinely permanent failure does — that would make the row permanently
    // un-sweepable even after the key is fixed. `attempts` is left at its
    // current value (0, the default for a brand-new row) instead.
    expect(delivery.attempts).toBe(0);
    expect(delivery.lastError).toMatch(/decrypt/i);
  });

  it("a permanent config fault (401) leaves attempts below MAX and stays selectable by the retry sweep", async () => {
    const { tenant, update } = await seed();
    await db.insert(webflowConnections).values({
      tenantId: tenant.id,
      ...encryptedToken(),
      siteId: "s1",
      collectionId: "c1",
      fieldMapping: webflowMapping,
      publishMode: "draft",
      status: "active",
    });

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ message: "Unauthorized" }, 401));

    await dispatchAllDestinations(update.id);

    const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBeLessThan(3);

    // Confirm the sweep actually still considers it: reconnect (flip the
    // connection back to active) and prove retryFailedDeliveries reaches it.
    await db
      .update(webflowConnections)
      .set({ status: "active" })
      .where(eq(webflowConnections.tenantId, tenant.id));
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(WEBFLOW_SCHEMA)).mockResolvedValueOnce(jsonResponse({ id: "item1" }, 202));

    await retryFailedDeliveries();

    const [retried] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(retried.status).toBe("success");
  });

  it("a genuinely permanent failure (400 validation error) still pins attempts to MAX and is skipped by the sweep", async () => {
    const { tenant, update } = await seed();
    await db.insert(webflowConnections).values({
      tenantId: tenant.id,
      ...encryptedToken(),
      siteId: "s1",
      collectionId: "c1",
      fieldMapping: webflowMapping,
      publishMode: "draft",
      status: "active",
    });

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(WEBFLOW_SCHEMA))
      .mockResolvedValueOnce(
        jsonResponse(
          { message: "Validation Error", details: [{ param: "author", description: "Field is required" }] },
          400
        )
      );

    await dispatchAllDestinations(update.id);

    const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBe(3);

    vi.mocked(fetch).mockClear();
    await retryFailedDeliveries();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resets attempts to 1 on a fresh re-publish even when the prior delivery was permanent and exhausted", async () => {
    // The ledger flagged this as missing: dispatchAllDestinations already
    // resets a fresh publish's retry budget for retryable/ok outcomes (see
    // "resets the retry budget on a fresh publish" above), but nothing proved
    // it also does so when the PRIOR attempt was exhausted by a genuine
    // (non-configFault) permanent classification, e.g. a 400 the user fixed
    // by correcting the update's content before re-publishing.
    const { tenant, update } = await seed();
    await db.insert(webflowConnections).values({
      tenantId: tenant.id,
      ...encryptedToken(),
      siteId: "s1",
      collectionId: "c1",
      fieldMapping: webflowMapping,
      publishMode: "draft",
      status: "active",
    });

    // First publish: Webflow 400s on a required field — genuinely permanent,
    // pinned to MAX_ATTEMPTS.
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(WEBFLOW_SCHEMA))
      .mockResolvedValueOnce(
        jsonResponse(
          { message: "Validation Error", details: [{ param: "author", description: "Field is required" }] },
          400
        )
      );
    await dispatchAllDestinations(update.id);

    let [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBe(3);

    // The user fixes the content and re-publishes; this time it succeeds.
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(WEBFLOW_SCHEMA)).mockResolvedValueOnce(jsonResponse({ id: "item1" }, 202));
    await dispatchAllDestinations(update.id);

    [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(delivery.status).toBe("success");
    expect(delivery.attempts).toBe(1);
  });

  it("does not create a duplicate CMS item when a re-publish and the retry sweep race on the same delivery attempt", async () => {
    // Regression test for the race dispatch.ts's row lock fixes:
    // dispatchAllDestinations (a re-publish) and retryFailedDeliveries (the
    // cron sweep) both used to read the same delivery_attempts row before
    // either wrote to it. Merely calling them back-to-back does NOT
    // reproduce this — the reviewer noted a naive test like that passed
    // against the racy code because the pooled pg client happened to
    // serialize the two calls anyway. This test forces genuine interleaving
    // with an explicit barrier: it pauses whichever call wins the row first,
    // starts the second while the first is still "in flight", then releases
    // the first — so a build without the lock has both read externalId as
    // null and each independently create a Webflow item, silently orphaning
    // one (only the last writer's externalId survives).
    const { tenant, update } = await seed();
    await db.insert(webflowConnections).values({
      tenantId: tenant.id,
      ...encryptedToken(),
      siteId: "s1",
      collectionId: "c1",
      fieldMapping: webflowMapping,
      publishMode: "draft",
      status: "active",
    });
    // The state a concurrent "sweep the failure" + "user re-publishes" race
    // starts from: a prior attempt failed before ever creating an item.
    await db.insert(deliveryAttempts).values({
      contentPieceId: update.id,
      destination: "webflow",
      status: "failed",
      attempts: 1,
      externalId: null,
    });

    let releaseFirstClaimant!: () => void;
    const firstClaimantPaused = new Promise<void>((resolve) => {
      releaseFirstClaimant = resolve;
    });
    let signalFirstClaimantStarted!: () => void;
    const firstClaimantStarted = new Promise<void>((resolve) => {
      signalFirstClaimantStarted = resolve;
    });

    let schemaFetchCount = 0;
    const createdIds: string[] = [];
    const updatedIds: string[] = [];

    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET" && /\/v2\/collections\/[^/]+$/.test(url)) {
        schemaFetchCount++;
        if (schemaFetchCount === 1) {
          // Whichever claimant wins the row lock reaches here first. Signal
          // the test to start the second (racing) claimant now, then pause —
          // still inside the transaction, lock held — long enough for the
          // second claimant's `SELECT ... FOR UPDATE` to actually reach
          // Postgres and, under the fix, block on it.
          signalFirstClaimantStarted();
          await firstClaimantPaused;
        }
        return jsonResponse(WEBFLOW_SCHEMA);
      }
      if (method === "POST") {
        const id = `item-${createdIds.length + 1}`;
        createdIds.push(id);
        return jsonResponse({ id }, 202);
      }
      if (method === "PATCH") {
        const id = url.split("/").pop() as string;
        updatedIds.push(id);
        return jsonResponse({ id }, 200);
      }
      throw new Error(`Unexpected fetch in race test: ${method} ${url}`);
    });

    const republish = dispatchAllDestinations(update.id);
    await firstClaimantStarted;
    const sweep = retryFailedDeliveries();
    // Give the sweep's `SELECT ... FOR UPDATE` real time to reach Postgres
    // and start blocking on the first claimant's row lock before releasing it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    releaseFirstClaimant();

    await Promise.all([republish, sweep]);

    // Exactly one item ever created, and exactly one delivery total: the
    // second claimant (the sweep) re-reads the row once it finally gets the
    // lock, sees the first claimant already recorded success, and bails out
    // instead of redundantly PATCHing a CMS item the customer can see. Before
    // the dedup fix this asserted `updatedIds` had length 1 — i.e. it
    // encoded a genuine duplicate live delivery as the expected outcome,
    // which is exactly the bug this test now guards against.
    expect(createdIds).toHaveLength(1);
    expect(updatedIds).toHaveLength(0);

    const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(delivery.status).toBe("success");
    expect(delivery.externalId).toBe(createdIds[0]);
  });

  it("recovers instead of dropping the delivery when two concurrent first-ever publishes race the insert", async () => {
    // Regression test for the unique-violation recovery branch in
    // claimAndDeliver: when NO delivery_attempts row exists yet (a genuine
    // first-ever publish, e.g. a double-clicked Approve button, or
    // approveDraft racing the scheduler's auto-publish), two claimants can
    // both find no existing row and both attempt the INSERT. Only one wins;
    // the loser must recover under the row lock rather than have the
    // unique-violation propagate and silently drop its delivery.
    //
    // Calling dispatchAllDestinations twice back-to-back does NOT reproduce
    // this: the row-lock test above already showed the pooled client can
    // serialize sequential calls. This forces genuine interleaving with a
    // barrier so both claimants' inserts are in flight at once: the winner's
    // insert succeeds but stays uncommitted (its transaction is still open,
    // paused inside deliver()) while the loser's insert reaches Postgres and
    // blocks on the winner's uncommitted row — a real unique-index race, not
    // two serialized transactions.
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });

    let releaseFirstClaimant!: () => void;
    const firstClaimantPaused = new Promise<void>((resolve) => {
      releaseFirstClaimant = resolve;
    });
    let signalFirstClaimantStarted!: () => void;
    const firstClaimantStarted = new Promise<void>((resolve) => {
      signalFirstClaimantStarted = resolve;
    });

    let fetchCount = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      fetchCount++;
      if (fetchCount === 1) {
        // Whichever claimant wins the insert reaches here first, still
        // inside its transaction with the row inserted but NOT committed.
        // Signal the test to start the second (racing) claimant now, then
        // pause — long enough for its SELECT ... FOR UPDATE (finding no
        // committed row yet) and its own INSERT to actually reach Postgres
        // and block on the winner's uncommitted insert.
        signalFirstClaimantStarted();
        await firstClaimantPaused;
      }
      return { ok: true } as Response;
    });

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const first = dispatchAllDestinations(update.id);
    await firstClaimantStarted;
    const second = dispatchAllDestinations(update.id);
    // Give the second claimant's SELECT and INSERT real time to reach
    // Postgres and start blocking on the first claimant's uncommitted row
    // before releasing it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    releaseFirstClaimant();

    await Promise.all([first, second]);
    consoleErrorSpy.mockRestore();

    // Exactly one row: the unique constraint holds regardless of the fix —
    // what the fix changes is whether the loser recovers into it cleanly.
    const deliveries = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].status).toBe("success");

    // Both claimants' deliveries actually went out — the loser's delivery is
    // not silently dropped. Before the fix, the loser's unique-violation was
    // never recognized as such (checked the wrong property) and, even where
    // it was, retrying the read in the same aborted transaction (Postgres
    // 25P02) would fail too — either way the loser's fetch is never reached
    // and `Dispatch to webhook failed ... Failed query: insert into
    // "delivery_attempts"` is logged instead.
    expect(fetchCount).toBe(2);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("two overlapping sweep retries of the same failed row deliver exactly once and increment attempts by exactly one", async () => {
    // Regression test for claimAndDeliver's missing re-check: retryFailedDeliveries's
    // outer SELECT decides a row is eligible BEFORE any lock is held, so two
    // overlapping sweep ticks (the cron firing twice, or a manual "retry now"
    // racing the scheduled sweep) can both select the same failed row and
    // both enter claimAndDeliver for it. Without re-reading status/attempts
    // once the lock is actually held, both would redeliver — a genuine
    // duplicate POST to the customer's endpoint, and attempts driven up by 2
    // instead of 1, burning retry budget on a delivery that already
    // succeeded.
    const { tenant, update } = await seed();
    await db.insert(webhookConfigs).values({ tenantId: tenant.id, url: "https://example.com/hook", ...encryptedSecret() });
    await db.insert(deliveryAttempts).values({
      contentPieceId: update.id,
      destination: "webhook",
      status: "failed",
      attempts: 1,
    });

    let releaseFirstClaimant!: () => void;
    const firstClaimantPaused = new Promise<void>((resolve) => {
      releaseFirstClaimant = resolve;
    });
    let signalFirstClaimantStarted!: () => void;
    const firstClaimantStarted = new Promise<void>((resolve) => {
      signalFirstClaimantStarted = resolve;
    });

    let fetchCount = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      fetchCount++;
      if (fetchCount === 1) {
        // Whichever sweep wins the row lock reaches here first. Signal the
        // test to start the second (racing) sweep now, then pause — still
        // inside the transaction, lock held — long enough for the second
        // sweep's `SELECT ... FOR UPDATE` to actually reach Postgres and,
        // under the fix, block on it.
        signalFirstClaimantStarted();
        await firstClaimantPaused;
      }
      return { ok: true } as Response;
    });

    const firstSweep = retryFailedDeliveries();
    await firstClaimantStarted;
    const secondSweep = retryFailedDeliveries();
    // Give the second sweep's `SELECT ... FOR UPDATE` real time to reach
    // Postgres and start blocking on the first sweep's row lock before
    // releasing it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    releaseFirstClaimant();

    await Promise.all([firstSweep, secondSweep]);

    // Exactly one fetch: the second sweep re-reads the row once it gets the
    // lock, sees the first sweep already recorded success, and bails out
    // instead of redelivering.
    expect(fetchCount).toBe(1);

    const [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
    expect(delivery.status).toBe("success");
    // Started at 1, one sweep's delivery increments it — not two.
    expect(delivery.attempts).toBe(2);
  });
});
