# Image Generation — Delivery to Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry a piece's cover image to every publish destination — `coverImage` on the webhook payload, a `{ url, alt }` Image field in Webflow, and a native image post on LinkedIn — without re-uploading on retry.

**Architecture:** One tiny module, `src/lib/publishing/cover-image.ts`, turns Plan 1's `getCoverImage()` row into a `{ url, alt, width, height } | null` payload that all three destinations consume. Webhook and Webflow are pure additions to existing payload builders. LinkedIn is the only new network flow (initialize → PUT bytes → poll → post-with-media); the image URN it mints is persisted on a new nullable `delivery_attempts.metadata` jsonb column and handed back to `deliver()` on the next attempt so the sweep never uploads twice.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM (`drizzle-kit generate` / `migrate`), Postgres, Vitest, LinkedIn Images API + Posts API (REST, `LinkedIn-Version` header), Webflow Data API v2.

**Spec:** docs/superpowers/specs/2026-08-18-image-generation-design.md — this plan owns **§8 (Image transfer to integrations)** in full: Webflow, LinkedIn, Webhook subsections. It assumes Plans 1–3 are merged (`content_images`, `image_renders`, `getCoverImage`).

## Global Constraints

- Run `npm install` in the worktree before anything (no node_modules).
- Tests: vitest; node project under tests/** (real Postgres via vitest.setup.ts, uses tests/helpers/fixtures.ts), jsdom project under tests/components/**. Run a single file with `npx vitest run tests/path/file.test.ts`. The suite is flaky when run whole — run the files you touched.
- Migrations: `npm run db:generate` after schema edits; commit the generated SQL in src/db/migrations. Then `npm run db:migrate` and `npm run db:migrate:test`. Never hand-write the SQL file.
- Commit after every task; message style: lowercase imperative, `feat:`/`fix:`/`test:`/`docs:` prefix, no Co-Authored-By needed.
- **No test may reach LinkedIn, Webflow, or Vercel Blob.** Every network call is behind `vi.stubGlobal("fetch", vi.fn())` or a `vi.mock` of the client module — exactly as the existing tests under tests/lib/publishing/** and tests/lib/integrations/** already do.
- `DbClient` (src/lib/publishing/destinations/types.ts:11) is the DB handle type every destination and lib module takes; dispatch passes a transaction handle, so never type it as `typeof db`.
- The `Destination` interface change (Task 1) is **additive**: a fifth optional `metadata` argument and an optional `metadata` field on non-permanent results. Existing test call sites `deliver(piece, config, externalId, db)` keep compiling.
- Retry semantics stay in dispatch.ts: destinations only *return* `retryable`/`permanent`; they never sleep past the LinkedIn poll budget or loop on their own.
- The UI cannot be visually verified (dev preview is behind an OAuth wall); UI-only steps are gated by `npm run typecheck`, `npm run lint`, and `npm run build`.

## Consumed from Plans 1–3 (do not redefine)

```ts
// src/lib/images/store.ts (Plan 1)
export async function getCoverImage(tenantId: string, contentPieceId: string, database?: DbClient):
  Promise<(ContentImage & { current: ImageRender | null }) | null>;
// ContentImage has: id, tenantId, contentPieceId, role, concept, altText, sourceKind, status ("pending"|"ready"|"failed"), currentRenderId
// ImageRender has: id, imageId, prompt, blobUrl, blobPathname, width, height, bytes, model
// src/db/schema.ts (Plan 1): contentImages, imageRenders tables
```

## Publish-order sanity (spec §8, checked, no change)

`src/lib/publishing/dispatch.ts:12` registers `[webhookDestination, webflowDestination, linkedinDestination]` — Webflow delivers **before** LinkedIn, so by the time the LinkedIn post goes out the blog page (and its og:image, if the tenant mapped it) already exists. Native image posts don't depend on this, but keep the order; `tests/lib/publishing/dispatch.test.ts:166-170` pins it.

---

### Task 1: `delivery_attempts.metadata` and the destination contract

**Files:**
- Modify: `src/db/schema.ts` (deliveryAttempts, lines 683–710; add the `DeliveryMetadata` type just above it)
- Create: `src/db/migrations/<next>_*.sql` (generated)
- Modify: `src/lib/publishing/destinations/types.ts` (lines 15–35)
- Modify: `src/lib/publishing/dispatch.ts` (lines 140–152)
- Modify: `src/lib/publishing/destinations/webhook.ts` (line 40–44 comment only, no behavior)
- Test: `tests/db/delivery-attempts-metadata.test.ts` (new)

**Interfaces:**
- Produces: `DeliveryMetadata = { linkedinImageUrn?: string }` (schema.ts, re-exported from types.ts); `deliveryAttempts.metadata` nullable jsonb; `Destination.deliver(piece, config, externalId, database, metadata?)`; `DeliveryResult` `ok`/`retryable` variants gain `metadata?: DeliveryMetadata`. Task 7 reads and writes it.

- [ ] **Step 1: Write the failing schema test**

Create `tests/db/delivery-attempts-metadata.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, contentPieces, deliveryAttempts } from "../../src/db/schema";

const TENANT = "Delivery Attempts Metadata Schema Test Tenant";

async function seedPiece() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, title: "T", body: "B" })
    .returning();
  return piece;
}

describe("delivery_attempts.metadata", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("defaults to null and round-trips a linkedin image urn", async () => {
    const piece = await seedPiece();
    const [row] = await db
      .insert(deliveryAttempts)
      .values({ contentPieceId: piece.id, destination: "linkedin" })
      .returning();
    expect(row.metadata).toBeNull();

    const [updated] = await db
      .update(deliveryAttempts)
      .set({ metadata: { linkedinImageUrn: "urn:li:image:abc" } })
      .where(eq(deliveryAttempts.id, row.id))
      .returning();
    expect(updated.metadata).toEqual({ linkedinImageUrn: "urn:li:image:abc" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/db/delivery-attempts-metadata.test.ts`
Expected: FAIL — `metadata` does not exist on the insert/update type.

- [ ] **Step 3: Add the type and column to the schema**

In `src/db/schema.ts`, directly above `export const deliveryAttempts = pgTable(` (line 683):

```ts
// Destination-private state that must survive across attempts of the SAME
// delivery. Today only LinkedIn uses it: the image URN minted by the Images
// API before the post step, so a retry after a stuck upload or a failed post
// reuses the upload instead of minting a second one. jsonb rather than a
// column per destination — the next destination that needs scratch state
// adds a key, not a migration.
export type DeliveryMetadata = { linkedinImageUrn?: string };
```

Inside the `deliveryAttempts` columns, after `externalId: text("external_id"),` (line 697):

```ts
    // See DeliveryMetadata. Null until a destination returns some; carried
    // forward unchanged by dispatch when a later result returns none.
    metadata: jsonb("metadata").$type<DeliveryMetadata>(),
```

- [ ] **Step 4: Generate and apply the migration**

```bash
npm run db:generate
npm run db:migrate
npm run db:migrate:test
```

Confirm exactly one new file under `src/db/migrations/` and that it contains a single `ALTER TABLE "delivery_attempts" ADD COLUMN "metadata" jsonb;`. Anything else means schema drift — stop and report.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/db/delivery-attempts-metadata.test.ts`
Expected: PASS.

- [ ] **Step 6: Extend the destination contract**

In `src/lib/publishing/destinations/types.ts`, add to the imports at the top (after line 3, `import type * as schema from "@/db/schema";`):

```ts
import type { DeliveryMetadata } from "@/db/schema";
// Re-exported so destinations import everything delivery-shaped from here.
export type { DeliveryMetadata };
```

Then replace lines 15–35 (`DeliveryResult` through the `Destination` interface) with:

```ts
export type DeliveryResult =
  // `externalId` is stored so a later re-publish can update rather than duplicate.
  // `metadata` (optional) is destination-private state persisted on the
  // attempt row and handed back on the next `deliver` call — see
  // DeliveryMetadata in schema.ts. Omitting it leaves the stored value as-is.
  | { status: "ok"; externalId?: string; metadata?: DeliveryMetadata }
  // Worth another attempt in the cron sweep: network, 429, 5xx, or an upload
  // LinkedIn is still processing. `metadata` lets that retry pick up where
  // this attempt stopped instead of redoing its side effects.
  | { status: "retryable"; error: string; metadata?: DeliveryMetadata }
  // Retrying cannot help: bad credentials, validation failure, empty body.
  // `configFault` marks the subset caused by connection/credential SETUP
  // (a revoked token, an undecryptable secret, an incomplete wizard) rather
  // than by the content being published. dispatch.ts uses it to decide
  // whether to pin `attempts` to the retry cap: a genuine content/validation
  // failure should stop the sweep from retrying forever, but a config fault
  // is fixable by the user, so the row must stay sweepable once they fix it.
  | { status: "permanent"; error: string; configFault?: true };

export interface Destination<TConfig> {
  id: DestinationId;
  /** Human-readable name shown in the publish-destinations modal. */
  label: string;
  loadConfig(tenantId: string, database: DbClient): Promise<TConfig | null>;
  // `metadata` is whatever the previous attempt for this piece+destination
  // returned (null on a first attempt). Optional so destinations that keep no
  // cross-attempt state (webhook, webflow) neither declare nor receive it, and
  // their existing call sites keep compiling.
  deliver(
    piece: ContentPiece,
    config: TConfig,
    externalId: string | null,
    database: DbClient,
    metadata?: DeliveryMetadata | null
  ): Promise<DeliveryResult>;
}
```

- [ ] **Step 7: Read and write it in dispatch**

In `src/lib/publishing/dispatch.ts`, replace lines 140–152:

```ts
    const result = await destination.deliver(piece, config, attempt.externalId, tx, attempt.metadata);
    const attempts = attemptsFor(result, attempt.attempts);
    // Carry metadata forward unless this result replaced it. A permanent
    // failure never returns any (the row is done), so it keeps whatever the
    // last non-permanent attempt left — harmless, and useful in the UI.
    const metadata = result.status !== "permanent" && result.metadata ? result.metadata : attempt.metadata;

    await tx
      .update(deliveryAttempts)
      .set({
        status: statusFor(result),
        ...(attempts !== undefined ? { attempts } : {}),
        lastError: result.status === "ok" ? null : result.error,
        externalId: result.status === "ok" ? (result.externalId ?? attempt.externalId) : attempt.externalId,
        metadata,
        lastAttemptAt: new Date(),
      })
      .where(eq(deliveryAttempts.id, attempt.id));
```

- [ ] **Step 8: Typecheck, lint, run the neighbouring suites**

```bash
npm run typecheck
npm run lint
npx vitest run tests/lib/publishing/dispatch.test.ts tests/lib/publishing/linkedin-destination.test.ts tests/lib/publishing/destinations/webflow.test.ts
```

Expected: all green. (Nothing returns metadata yet; the point is that the four-argument `deliver` calls in the tests still compile.)

- [ ] **Step 9: Commit**

```bash
git add src/db/schema.ts src/db/migrations src/lib/publishing/destinations/types.ts src/lib/publishing/dispatch.ts tests/db/delivery-attempts-metadata.test.ts
git commit -m "feat: delivery attempts carry destination metadata across retries"
```

---

### Task 2: `loadCoverImagePayload` — the one cover reader

**Files:**
- Create: `src/lib/publishing/cover-image.ts`
- Test: `tests/lib/publishing/cover-image.test.ts` (new, real Postgres)

**Interfaces:**
- Consumes: `getCoverImage(tenantId, contentPieceId, database)` from `src/lib/images/store.ts` (Plan 1); `contentImages`, `imageRenders` from schema (Plan 1).
- Produces:
  ```ts
  export type CoverImagePayload = { url: string; alt: string; width: number; height: number };
  export async function loadCoverImagePayload(tenantId: string, contentPieceId: string, database: DbClient): Promise<CoverImagePayload | null>;
  ```
  Tasks 3, 5, 7 consume it. Tests mock this module, so it must stay the single seam.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/publishing/cover-image.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { tenants, contentPieces, contentImages, imageRenders } from "../../../src/db/schema";
import { loadCoverImagePayload } from "../../../src/lib/publishing/cover-image";

const TENANT = "Cover Image Payload Test Tenant";

async function seedPiece() {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning();
  const [piece] = await db
    .insert(contentPieces)
    .values({ tenantId: tenant.id, title: "T", body: "B", type: "blog_post" })
    .returning();
  return { tenant, piece };
}

// Inserts the rows Plan 1's addRender() would leave behind for a ready cover,
// without going through renderImage/uploadPng: a content_images row whose
// currentRenderId points at one image_renders row.
async function seedCover(tenantId: string, contentPieceId: string, status: "ready" | "pending" | "failed" = "ready") {
  const [image] = await db
    .insert(contentImages)
    .values({
      tenantId,
      contentPieceId,
      role: "cover",
      concept: "a lighthouse beam sweeping over a data grid",
      altText: "Lighthouse beam over a grid of glowing tiles",
      sourceKind: "generated",
      status,
    })
    .returning();
  const [render] = await db
    .insert(imageRenders)
    .values({
      imageId: image.id,
      prompt: "p",
      blobUrl: "https://blob.example/tenants/t/content/p/cover-x-abc.png",
      blobPathname: "tenants/t/content/p/cover-x-abc.png",
      width: 1200,
      height: 630,
      bytes: 123456,
      model: "openai/gpt-image-2",
    })
    .returning();
  await db.update(contentImages).set({ currentRenderId: render.id }).where(eq(contentImages.id, image.id));
  return { image, render };
}

describe("loadCoverImagePayload", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("returns url/alt/width/height for a ready cover with a current render", async () => {
    const { tenant, piece } = await seedPiece();
    await seedCover(tenant.id, piece.id);

    const cover = await loadCoverImagePayload(tenant.id, piece.id, db);

    expect(cover).toEqual({
      url: "https://blob.example/tenants/t/content/p/cover-x-abc.png",
      alt: "Lighthouse beam over a grid of glowing tiles",
      width: 1200,
      height: 630,
    });
  });

  it("returns null when the piece has no cover row", async () => {
    const { tenant, piece } = await seedPiece();
    expect(await loadCoverImagePayload(tenant.id, piece.id, db)).toBeNull();
  });

  it("returns null when the cover is not ready (failed render), even if a render row exists", async () => {
    const { tenant, piece } = await seedPiece();
    await seedCover(tenant.id, piece.id, "failed");
    expect(await loadCoverImagePayload(tenant.id, piece.id, db)).toBeNull();
  });

  it("refuses another tenant's cover", async () => {
    const { tenant, piece } = await seedPiece();
    await seedCover(tenant.id, piece.id);
    const [other] = await db.insert(tenants).values({ name: TENANT }).returning();
    expect(await loadCoverImagePayload(other.id, piece.id, db)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/publishing/cover-image.test.ts`
Expected: FAIL — cannot resolve `../../../src/lib/publishing/cover-image`.

- [ ] **Step 3: Write the module**

Create `src/lib/publishing/cover-image.ts`:

```ts
import { getCoverImage } from "@/lib/images/store";
import type { DbClient } from "./destinations/types";

// The cover as every destination sees it. Naming follows JSON Feed 1.1's
// `image` shape (spec §8, webhook): a public, stable, hotlinkable URL plus the
// alt and the dimensions so receivers can render a card without fetching.
export type CoverImagePayload = { url: string; alt: string; width: number; height: number };

// The one place delivery reads the cover row. A cover only travels when its
// row is `ready` AND has a current render — a `pending` (mid-regeneration)
// or `failed` cover must publish as "no cover", never as a dangling URL.
export async function loadCoverImagePayload(
  tenantId: string,
  contentPieceId: string,
  database: DbClient
): Promise<CoverImagePayload | null> {
  const cover = await getCoverImage(tenantId, contentPieceId, database);
  if (!cover || cover.status !== "ready" || !cover.current) return null;
  return {
    url: cover.current.blobUrl,
    alt: cover.altText,
    width: cover.current.width,
    height: cover.current.height,
  };
}
```

If Plan 1's `getCoverImage` signature differs from the brief (`(tenantId, contentPieceId, database?)`), adapt this call site only — nothing else in this plan touches `store.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/publishing/cover-image.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/publishing/cover-image.ts tests/lib/publishing/cover-image.test.ts
git commit -m "feat: one reader turns the cover row into a delivery payload"
```

---

### Task 3: Webhook payload gains `coverImage`

**Files:**
- Modify: `src/lib/publishing/destinations/webhook.ts` (lines 15–25 `buildPayload`, lines 40–52 `deliver` head)
- Modify: `tests/lib/publishing/dispatch.test.ts` (lines 81–86, the exact-keys assertion)
- Modify: `src/app/(dashboard)/integrations/webhook-config-form.tsx` (lines 30–32, the card copy)
- Test: `tests/lib/publishing/destinations/webhook.test.ts` (new)

**Interfaces:**
- Consumes: `loadCoverImagePayload` (Task 2).
- Produces: webhook JSON body has top-level `coverImage: { url, alt, width, height } | null`. Non-breaking.

- [ ] **Step 1: Write the failing destination test**

Create `tests/lib/publishing/destinations/webhook.test.ts`. There is no dedicated webhook test today (webhook is exercised through dispatch.test.ts against real Postgres); this one calls `deliver` directly with a stubbed `fetch` and a mocked cover reader, mirroring `linkedin-destination.test.ts`'s module-mock style:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/publishing/destinations/webhook.test.ts`
Expected: FAIL — `payload.coverImage` is `undefined`; the keys assertion lacks `coverImage`.

- [ ] **Step 3: Extend the payload builder and deliver**

In `src/lib/publishing/destinations/webhook.ts`:

Add the import after line 4 (`import { decryptSecret } ...`):

```ts
import { loadCoverImagePayload, type CoverImagePayload } from "@/lib/publishing/cover-image";
```

Replace `buildPayload` (lines 15–25):

```ts
function buildPayload(piece: ContentPiece, coverImage: CoverImagePayload | null) {
  return {
    id: piece.id,
    tenantId: piece.tenantId,
    title: piece.title,
    // Markdown. Body images are `![alt](https://…)` with absolute, stable,
    // hotlinkable Blob URLs — receivers may embed them directly.
    body: piece.body,
    status: piece.status,
    createdAt: piece.createdAt,
    publishedAt: piece.publishedAt,
    // The cover as a structured field (JSON Feed 1.1's `image` shape, spec
    // §8): null when the piece has no ready cover. Additive — every earlier
    // key keeps its meaning.
    coverImage,
  };
}
```

Replace lines 40–52 (the comment above `deliver`, the signature, and the `const body = ...` line):

```ts
  // `externalId` is part of the `Destination` interface (webflow updates an
  // existing CMS item by it), but webhook delivery has no notion of an
  // external id. `database` is used only to read the cover row.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async deliver(piece, config, _externalId, database): Promise<DeliveryResult> {
    const coverImage = await loadCoverImagePayload(piece.tenantId, piece.id, database);
    // A secret is optional. With one, sign the body (HMAC) and, on a decrypt
    // failure (rotated/misconfigured CREDENTIALS_ENCRYPTION_KEY), fail
    // permanently as a config fault — retrying can't help, and it must not be
    // logged identically to a network timeout. Decrypt outside and before the
    // fetch's try block so a decrypt failure is never caught there and
    // misclassified as retryable. Without a secret, deliver unsigned: no
    // signature header at all.
    const body = JSON.stringify(buildPayload(piece, coverImage));
```

Everything below `const body` (lines 53–90) is unchanged.

- [ ] **Step 4: Update the exact-keys assertion in dispatch.test.ts**

In `tests/lib/publishing/dispatch.test.ts`, replace lines 84–86:

```ts
    expect(Object.keys(payload).sort()).toEqual(
      ["body", "coverImage", "createdAt", "id", "publishedAt", "status", "tenantId", "title"].sort()
    );
    // The seeded piece has no cover row: the key is present, the value null.
    expect(payload.coverImage).toBeNull();
```

- [ ] **Step 5: Run both files**

Run: `npx vitest run tests/lib/publishing/destinations/webhook.test.ts tests/lib/publishing/dispatch.test.ts`
Expected: PASS. (dispatch.test.ts hits real Postgres and real `getCoverImage`; the seeded piece has no cover row so it returns null.)

- [ ] **Step 6: Document the payload where the user configures the webhook**

There is no README section or payload doc anywhere in the repo (grep for `x-product-announcer-signature` finds only the destination itself), so the integrations card copy is the only user-facing description. In `src/app/(dashboard)/integrations/webhook-config-form.tsx`, replace lines 30–32:

```tsx
      <p className="text-sm text-muted-foreground">
        Send every published piece to your own endpoint as JSON: <code>id</code>, <code>title</code>,{" "}
        <code>body</code> (markdown with absolute image URLs), <code>status</code>, <code>createdAt</code>,{" "}
        <code>publishedAt</code>, and <code>coverImage</code> (<code>{"{ url, alt, width, height }"}</code> or{" "}
        <code>null</code>). Image URLs are stable and safe to hotlink. Deliveries are signed with{" "}
        <code>x-product-announcer-signature</code> when a secret is set.
      </p>
```

- [ ] **Step 7: Typecheck, lint, build**

```bash
npm run typecheck && npm run lint && npm run build
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/publishing/destinations/webhook.ts tests/lib/publishing/destinations/webhook.test.ts tests/lib/publishing/dispatch.test.ts "src/app/(dashboard)/integrations/webhook-config-form.tsx"
git commit -m "feat: webhook payload carries the cover image"
```

---

### Task 4: Webflow mapping — `coverImage` source (pure)

**Files:**
- Modify: `src/db/schema.ts` (`WebflowFieldMapping`, lines 736–742)
- Modify: `src/lib/integrations/webflow/mapping.ts` (`buildFieldData` lines 7–43, `validateMapping` lines 45–68, `suggestMapping` lines 70–92)
- Modify: `tests/lib/integrations/webflow/mapping.test.ts` (line 47 call site; add cases)

**Interfaces:**
- Consumes: `CoverImagePayload` (Task 2).
- Produces:
  ```ts
  // schema.ts
  export type WebflowFieldMapping = Record<string,
    | { source: "title" | "body" | "slug" | "publishedAt" | "coverImage" | "empty" }
    | { source: "static"; value: string }>;
  // mapping.ts — signature change: the slug override moves into an options object
  export function buildFieldData(piece: ContentPiece, mapping: WebflowFieldMapping, fields: WebflowField[],
    opts?: { slugOverride?: string; cover?: CoverImagePayload | null }): Record<string, unknown>;
  ```
  Task 5 threads `cover` in from the destination.

- [ ] **Step 1: Write the failing tests**

In `tests/lib/integrations/webflow/mapping.test.ts`:

Add an Image field to the shared `fields` fixture (line 6–12) — Webflow Data API v2 reports image fields as `type: "Image"` (and galleries as `"MultiImage"`, which we do not map):

```ts
const fields: WebflowField[] = [
  { id: "f1", slug: "name", displayName: "Name", type: "PlainText", isRequired: true },
  { id: "f2", slug: "slug", displayName: "Slug", type: "PlainText", isRequired: true },
  { id: "f3", slug: "post-body", displayName: "Post Body", type: "RichText", isRequired: false },
  { id: "f4", slug: "published-on", displayName: "Published On", type: "DateTime", isRequired: false },
  { id: "f5", slug: "author", displayName: "Author", type: "Reference", isRequired: true },
  { id: "f6", slug: "main-image", displayName: "Main Image", type: "Image", isRequired: false },
];
```

Change line 47 to the new options-object call:

```ts
    expect(buildFieldData(update, mapping, fields, { slugOverride: "faster-search-2" }).slug).toBe("faster-search-2");
```

Append inside `describe("buildFieldData", ...)`:

```ts
  it("emits { url, alt } for a coverImage mapping when a cover is supplied", () => {
    const mapping: WebflowFieldMapping = { "main-image": { source: "coverImage" } };
    const data = buildFieldData(update, mapping, fields, {
      cover: { url: "https://blob.example/cover.png", alt: "Lighthouse over a grid", width: 1200, height: 630 },
    });
    expect(data["main-image"]).toEqual({ url: "https://blob.example/cover.png", alt: "Lighthouse over a grid" });
  });

  it("omits the key entirely for a coverImage mapping when the piece has no cover", () => {
    // Webflow 400s on `null` for an Image field; an absent key is "unchanged /
    // empty". findEmptyRequiredField in the destination treats an absent
    // required key as empty, so a required image field still fails clearly.
    const mapping: WebflowFieldMapping = { name: { source: "title" }, "main-image": { source: "coverImage" } };
    const data = buildFieldData(update, mapping, fields, { cover: null });
    expect(data).not.toHaveProperty("main-image");
    expect(data.name).toBe("Faster Search");
  });

  it("omits the coverImage key when no cover option is passed at all", () => {
    const mapping: WebflowFieldMapping = { "main-image": { source: "coverImage" } };
    expect(buildFieldData(update, mapping, fields)).not.toHaveProperty("main-image");
  });
```

Append inside `describe("validateMapping", ...)`:

```ts
  it("accepts coverImage on an Image field", () => {
    const mapping: WebflowFieldMapping = {
      name: { source: "title" },
      slug: { source: "slug" },
      author: { source: "static", value: "65f1abc" },
      "main-image": { source: "coverImage" },
    };
    expect(validateMapping(mapping, fields)).toEqual([]);
  });

  it("rejects coverImage on a non-Image field, naming the field and its type", () => {
    const mapping: WebflowFieldMapping = {
      name: { source: "title" },
      slug: { source: "slug" },
      author: { source: "static", value: "65f1abc" },
      "post-body": { source: "coverImage" },
    };
    const problems = validateMapping(mapping, fields);
    expect(problems.join(" ")).toContain("Post Body");
    expect(problems.join(" ")).toContain("RichText");
  });
```

Append inside `describe("suggestMapping", ...)`:

```ts
  it("auto-maps the first Image field to coverImage", () => {
    expect(suggestMapping(fields)["main-image"]).toEqual({ source: "coverImage" });
  });

  it("only maps the first Image field", () => {
    const twoImages: WebflowField[] = [
      ...fields,
      { id: "f7", slug: "thumbnail", displayName: "Thumbnail", type: "Image", isRequired: false },
    ];
    expect(suggestMapping(twoImages).thumbnail).toBeUndefined();
  });

  it("does not map a MultiImage gallery to coverImage", () => {
    const gallery: WebflowField[] = [
      { id: "g1", slug: "gallery", displayName: "Gallery", type: "MultiImage", isRequired: false },
    ];
    expect(suggestMapping(gallery).gallery).toBeUndefined();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/integrations/webflow/mapping.test.ts`
Expected: FAIL — type errors on `source: "coverImage"` and the options object; the new cases fail at runtime.

- [ ] **Step 3: Extend the schema union**

In `src/db/schema.ts`, replace lines 736–742:

```ts
// Keyed by Webflow field *slug*, not id, so renaming a field's display name in
// Webflow does not break the mapping. `coverImage` maps the piece's cover
// (spec §8): the destination sends `{ url, alt }` and Webflow rehosts the
// file itself — only valid on an Image-type field, which validateMapping
// enforces at save time.
export type WebflowFieldMapping = Record<
  string,
  | { source: "title" | "body" | "slug" | "publishedAt" | "coverImage" | "empty" }
  | { source: "static"; value: string }
>;
```

- [ ] **Step 4: Implement in mapping.ts**

Replace `src/lib/integrations/webflow/mapping.ts` lines 1–43 (imports + `buildFieldData`):

```ts
import type { WebflowFieldMapping } from "@/db/schema";
import { markdownToWebflowHtml } from "@/lib/publishing/markdown-to-html";
import { slugify } from "@/lib/publishing/slug";
import type { ContentPiece } from "@/lib/publishing/destinations/types";
import type { CoverImagePayload } from "@/lib/publishing/cover-image";
import type { WebflowField } from "./client";

// Webflow's field-type strings as the Data API v2 reports them in
// GET /v2/collections/{id}. Only the ones this module keys behaviour on.
const IMAGE_FIELD_TYPE = "Image";

export function buildFieldData(
  piece: ContentPiece,
  mapping: WebflowFieldMapping,
  fields: WebflowField[],
  opts: { slugOverride?: string; cover?: CoverImagePayload | null } = {}
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  for (const field of fields) {
    const entry = mapping[field.slug];
    if (!entry || entry.source === "empty") continue;

    switch (entry.source) {
      case "title":
        data[field.slug] = piece.title;
        break;
      case "body":
        data[field.slug] = markdownToWebflowHtml(piece.body);
        break;
      case "slug":
        data[field.slug] = opts.slugOverride ?? slugify(piece.title);
        break;
      case "publishedAt":
        // Webflow DateTime fields take ISO-8601. Fall back to now for an update
        // that has not been stamped yet.
        data[field.slug] = (piece.publishedAt ?? new Date()).toISOString();
        break;
      case "coverImage":
        // Webflow's Image field takes `{ url, alt }` with a public URL and
        // fetches + rehosts the file on its own CDN (spec §8) — no assets API,
        // so the tenant's existing cms:write Site token keeps working. When
        // the piece has no cover the key is OMITTED, not set to null: Webflow
        // 400s on null, while an absent key reads as empty — which
        // findEmptyRequiredField in the destination then reports as a clear
        // "required field is empty" error if the field is required.
        if (opts.cover) data[field.slug] = { url: opts.cover.url, alt: opts.cover.alt };
        break;
      case "static":
        data[field.slug] = entry.value;
        break;
    }
  }

  // Iterating `fields` rather than `mapping` means a mapping entry for a field
  // deleted in Webflow is silently ignored here; validateMapping surfaces it.
  return data;
}
```

In `validateMapping` (lines 45–68 of the original), replace the body with:

```ts
export function validateMapping(mapping: WebflowFieldMapping, fields: WebflowField[]): string[] {
  const problems: string[] = [];
  const knownSlugs = new Set(fields.map((f) => f.slug));

  for (const field of fields) {
    const entry = mapping[field.slug];
    // A cover can only land in an Image field. Anything else 400s at publish
    // time with a Webflow message the user can't act on, so refuse the save.
    if (entry?.source === "coverImage" && field.type !== IMAGE_FIELD_TYPE) {
      problems.push(
        `"${field.displayName}" is a ${field.type} field; Cover image can only be mapped to an Image field.`
      );
    }
    if (!field.isRequired) continue;
    if (!entry || entry.source === "empty") {
      problems.push(`"${field.displayName}" is required by Webflow but is not mapped.`);
      continue;
    }
    if (entry.source === "static" && !entry.value.trim()) {
      problems.push(`"${field.displayName}" is set to a static value but the value is blank.`);
    }
  }

  for (const slug of Object.keys(mapping)) {
    if (!knownSlugs.has(slug)) {
      problems.push(`Mapped field "${slug}" no longer exists in this collection.`);
    }
  }

  return problems;
}
```

In `suggestMapping` (lines 70–92 of the original), add an `imageTaken` flag and a branch:

```ts
export function suggestMapping(fields: WebflowField[]): WebflowFieldMapping {
  const suggestion: WebflowFieldMapping = {};
  let richTextTaken = false;
  let dateTaken = false;
  let imageTaken = false;

  for (const field of fields) {
    if (field.slug === "name") {
      suggestion.name = { source: "title" };
    } else if (field.slug === "slug") {
      suggestion.slug = { source: "slug" };
    } else if (field.type === "RichText" && !richTextTaken) {
      // Only the first: a second rich text field is usually an excerpt, and
      // duplicating the whole body into it is worse than leaving it blank.
      suggestion[field.slug] = { source: "body" };
      richTextTaken = true;
    } else if (field.type === "DateTime" && !dateTaken) {
      suggestion[field.slug] = { source: "publishedAt" };
      dateTaken = true;
    } else if (field.type === IMAGE_FIELD_TYPE && !imageTaken) {
      // The first single-Image field is almost always the hero/thumbnail.
      // MultiImage (galleries) are deliberately not matched.
      suggestion[field.slug] = { source: "coverImage" };
      imageTaken = true;
    }
  }

  return suggestion;
}
```

- [ ] **Step 5: Run the mapping test**

Run: `npx vitest run tests/lib/integrations/webflow/mapping.test.ts`
Expected: PASS (all original + 8 new cases).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exactly one error — `src/lib/publishing/destinations/webflow.ts:174` still calls `buildFieldData` with the positional slug string. Task 5 fixes it. If you'd rather not leave the tree red between commits, do Task 5 Step 3 now and commit both together; either is acceptable.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/lib/integrations/webflow/mapping.ts tests/lib/integrations/webflow/mapping.test.ts
git commit -m "feat: webflow mapping learns the coverImage source"
```

---

### Task 5: Webflow destination, mapping form and save action

**Files:**
- Modify: `src/lib/publishing/destinations/webflow.ts` (imports lines 12–14; the `while` loop lines 173–179)
- Modify: `src/app/(dashboard)/integrations/webflow-mapping-form.tsx` (`SOURCE_OPTIONS` lines 19–26; the Select items lines 116–122)
- Modify: `src/app/(dashboard)/integrations/actions.ts` (`saveWebflowMapping`, line 309 cast)
- Modify: `tests/lib/publishing/destinations/webflow.test.ts` (add the cover-image mock + 3 cases)

**Interfaces:**
- Consumes: `loadCoverImagePayload` (Task 2), new `buildFieldData` options (Task 4).
- Produces: a Webflow item write with `fieldData[<image slug>] = { url, alt }` when the mapping has a `coverImage` entry and the piece has a ready cover; a `permanent` "required field is empty" result when a required Image field has no cover.

- [ ] **Step 1: Write the failing destination tests**

In `tests/lib/publishing/destinations/webflow.test.ts`:

After the existing `vi.mock(... encryption ...)` block (lines 11–14) add:

```ts
// The cover reader hits Postgres for a real cover row; every case here uses
// a plain-object piece with a non-uuid id, so mock it and drive it per test.
vi.mock("../../../../src/lib/publishing/cover-image", () => ({ loadCoverImagePayload: vi.fn() }));
import { loadCoverImagePayload } from "../../../../src/lib/publishing/cover-image";
```

Add an Image field to `SCHEMA.fields` (line 22–26) and a second schema with it required:

```ts
    { id: "f4", slug: "main-image", displayName: "Main Image", type: "Image", isRequired: false },
```

```ts
const SCHEMA_REQUIRED_IMAGE = {
  ...SCHEMA,
  fields: SCHEMA.fields.map((f) => (f.slug === "main-image" ? { ...f, isRequired: true } : f)),
};

const mappingWithCover: WebflowFieldMapping = { ...mapping, "main-image": { source: "coverImage" } };

const COVER = { url: "https://blob.example/cover.png", alt: "Lighthouse over a grid", width: 1200, height: 630 };
```

In the first `beforeEach` (line 69–78) add, after the `decryptSecret` reinstatement:

```ts
    vi.mocked(loadCoverImagePayload).mockReset();
    vi.mocked(loadCoverImagePayload).mockResolvedValue(null);
```

Append inside `describe("webflowDestination.deliver", ...)` (before its closing `});` at line 354):

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/publishing/destinations/webflow.test.ts`
Expected: FAIL — typecheck on the `buildFieldData` call in webflow.ts, and the four new cases.

- [ ] **Step 3: Thread the cover through the destination**

In `src/lib/publishing/destinations/webflow.ts`:

Add after line 12 (`import { buildFieldData } ...`):

```ts
import { loadCoverImagePayload } from "@/lib/publishing/cover-image";
```

Replace lines 161–179 (from `try {` through the `buildFieldData(...)` call) with:

```ts
    try {
      // Re-fetch the schema rather than trusting the stored mapping: a field
      // deleted in Webflow since setup would otherwise 400 with no explanation.
      const collection = await getCollection(token, connection.collectionId);

      // Read the cover row only when the mapping actually sends it — most
      // collections predate cover images and shouldn't pay a query for it.
      const wantsCover = Object.values(connection.fieldMapping).some((entry) => entry.source === "coverImage");
      const cover = wantsCover ? await loadCoverImagePayload(piece.tenantId, piece.id, database) : null;

      const baseSlug = slugify(piece.title);
      let lastError: DeliveryResult | null = null;
      // Tracks genuine slug-collision retries only. Kept separate from the
      // 404-fallback below so a deleted-item recovery never eats into this
      // budget or skips ahead to a suffixed slug it never needed.
      let slugAttempt = 0;

      while (slugAttempt < MAX_SLUG_ATTEMPTS) {
        const fieldData = buildFieldData(piece, connection.fieldMapping, collection.fields, {
          slugOverride: withSuffix(baseSlug, slugAttempt),
          cover,
        });
```

Lines 181–221 (the `findEmptyRequiredField` check onward) are unchanged. Note `findEmptyRequiredField` (lines 33–43) already treats an absent key (`value === undefined`) as empty — that is what turns "required Image field, no cover" into the readable error the third test asserts, with no change to that function.

- [ ] **Step 4: Run the destination test**

Run: `npx vitest run tests/lib/publishing/destinations/webflow.test.ts`
Expected: PASS (all previous + 4 new).

- [ ] **Step 5: The mapping form offers "Cover image" on Image fields**

In `src/app/(dashboard)/integrations/webflow-mapping-form.tsx`:

Replace `SOURCE_OPTIONS` (lines 19–26):

```ts
// "Update title"/"Update body" renamed to plain "Title"/"Body" (UX review):
// "Update" is the pre-pivot name for a content piece, and the new "Cover
// image" option would sit inconsistently beside it ("Update cover image"?).
// All sources describe the piece being published; the prefix added nothing.
const SOURCE_OPTIONS = [
  { value: "title", label: "Title" },
  { value: "body", label: "Body" },
  { value: "slug", label: "Slug" },
  { value: "publishedAt", label: "Published date" },
  { value: "coverImage", label: "Cover image" },
  { value: "static", label: "Static value" },
  { value: "empty", label: "Leave empty" },
];

// "Cover image" is only meaningful on a Webflow Image field (validateMapping
// rejects it anywhere else), so don't offer it where it can't be saved.
function optionsFor(fieldType: string) {
  return SOURCE_OPTIONS.filter((option) => option.value !== "coverImage" || fieldType === "Image");
}
```

Replace the option list inside `<SelectContent>` (lines 117–121):

```tsx
                {optionsFor(field.type).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
```

`labelFor(SOURCE_OPTIONS, …)` on line 114 keeps working: a stored `coverImage` mapping on an Image field still resolves its label.

- [ ] **Step 6: The save action accepts the new source**

In `src/app/(dashboard)/integrations/actions.ts`, replace line 309:

```ts
        mapping[field.slug] = { source: source as "title" | "body" | "slug" | "publishedAt" | "coverImage" | "empty" };
```

`validateMapping` runs two lines below (line 315) and is what rejects `coverImage` on a non-Image field, so a hand-crafted POST cannot store an invalid mapping.

- [ ] **Step 7: Typecheck, lint, build**

```bash
npm run typecheck && npm run lint && npm run build
```

Expected: clean. Manual verification (cannot be automated here): on `/integrations` with a Webflow collection that has an Image field, the field's source Select offers "Cover image"; a PlainText field's Select does not.

- [ ] **Step 8: Commit**

```bash
git add src/lib/publishing/destinations/webflow.ts tests/lib/publishing/destinations/webflow.test.ts "src/app/(dashboard)/integrations/webflow-mapping-form.tsx" "src/app/(dashboard)/integrations/actions.ts"
git commit -m "feat: webflow publishes the cover into the mapped image field"
```

---

### Task 6: LinkedIn client — Images API + `createPost` media

**Files:**
- Modify: `src/lib/integrations/linkedin/client.ts` (append after line 154; replace `createPost` lines 164–182)
- Modify: `tests/lib/integrations/linkedin-client.test.ts` (imports lines 2–10; append cases)

**Interfaces:**
- Produces:
  ```ts
  export type LinkedinImageStatus = "PROCESSING" | "AVAILABLE" | "FAILED";
  export async function initializeImageUpload(args: { accessToken: string; ownerUrn: string }): Promise<{ uploadUrl: string; imageUrn: string }>;
  export async function uploadImageBytes(args: { uploadUrl: string; bytes: Uint8Array; accessToken: string }): Promise<void>;
  export async function getImageStatus(args: { accessToken: string; imageUrn: string }): Promise<LinkedinImageStatus>;
  export async function createPost(args: { accessToken: string; authorUrn: string; commentary: string; media?: { imageUrn: string; altText: string } }): Promise<{ postUrn: string }>;
  ```
  Task 7 consumes all four.

LinkedIn API facts these steps encode (Images API, versioned REST):
- `POST /rest/images?action=initializeUpload` with body `{ "initializeUploadRequest": { "owner": "<org urn>" } }` → `{ "value": { "uploadUrl": "...", "image": "urn:li:image:...", "uploadUrlExpiresAt": ... } }`. (Spec §8 writes the body loosely as `{ owner }`; the wire format needs the `initializeUploadRequest` wrapper.)
- `PUT <uploadUrl>` with the raw bytes and the same `Authorization: Bearer` header; the upload URL is absolute (a LinkedIn media host, not `api.linkedin.com`), so it does not go through `restRequest`.
- `GET /rest/images/{urlencoded urn}` → `{ "status": "PROCESSING" | "AVAILABLE" | "FAILED" | "WAITING_UPLOAD", ... }`. Anything that is not `AVAILABLE`/`FAILED` is treated as still processing.
- Posts API: `content: { media: { id: "urn:li:image:...", altText: "..." } }` alongside `commentary`; the same headers `createPost` already sends (`LinkedIn-Version`, `X-Restli-Protocol-Version: 2.0.0`, lines 110–113).

- [ ] **Step 1: Write the failing client tests**

In `tests/lib/integrations/linkedin-client.test.ts`, extend the import (lines 2–10):

```ts
import {
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
  listAdminOrganizations,
  createPost,
  escapeLittleText,
  initializeImageUpload,
  uploadImageBytes,
  getImageStatus,
  LinkedinApiError,
} from "../../../src/lib/integrations/linkedin/client";
```

Append inside `describe("linkedin client", ...)` (before its closing `});`):

```ts
  describe("images api", () => {
    it("initializeImageUpload posts the owner wrapper and returns uploadUrl + image urn", async () => {
      vi.mocked(fetch).mockResolvedValue(
        jsonResponse({ value: { uploadUrl: "https://media.example/upload/1", image: "urn:li:image:abc", uploadUrlExpiresAt: 1 } })
      );
      const res = await initializeImageUpload({ accessToken: "at", ownerUrn: "urn:li:organization:1" });
      expect(res).toEqual({ uploadUrl: "https://media.example/upload/1", imageUrn: "urn:li:image:abc" });
      const [url, init] = vi.mocked(fetch).mock.calls[0]!;
      expect(url).toBe("https://api.linkedin.com/rest/images?action=initializeUpload");
      expect((init as RequestInit).method).toBe("POST");
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        initializeUploadRequest: { owner: "urn:li:organization:1" },
      });
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["LinkedIn-Version"]).toBeDefined();
      expect(headers["X-Restli-Protocol-Version"]).toBe("2.0.0");
    });

    it("uploadImageBytes PUTs the bytes to the upload url as octet-stream with the bearer token", async () => {
      vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 201 }));
      const bytes = new Uint8Array([137, 80, 78, 71]);
      await uploadImageBytes({ uploadUrl: "https://media.example/upload/1", bytes, accessToken: "at" });
      const [url, init] = vi.mocked(fetch).mock.calls[0]!;
      expect(url).toBe("https://media.example/upload/1");
      expect((init as RequestInit).method).toBe("PUT");
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer at");
      expect(headers["content-type"]).toBe("application/octet-stream");
      expect((init as RequestInit).body).toBe(bytes);
    });

    it("uploadImageBytes throws LinkedinApiError on a non-2xx", async () => {
      vi.mocked(fetch).mockResolvedValue(new Response("nope", { status: 500 }));
      await expect(
        uploadImageBytes({ uploadUrl: "https://media.example/upload/1", bytes: new Uint8Array(), accessToken: "at" })
      ).rejects.toMatchObject({ status: 500 });
    });

    it("getImageStatus GETs the url-encoded urn and maps the status", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ id: "urn:li:image:abc", status: "AVAILABLE" }));
      expect(await getImageStatus({ accessToken: "at", imageUrn: "urn:li:image:abc" })).toBe("AVAILABLE");
      expect(vi.mocked(fetch).mock.calls[0]![0]).toBe("https://api.linkedin.com/rest/images/urn%3Ali%3Aimage%3Aabc");

      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ status: "FAILED" }));
      expect(await getImageStatus({ accessToken: "at", imageUrn: "urn:li:image:abc" })).toBe("FAILED");

      // WAITING_UPLOAD / PROCESSING / anything unknown → still processing.
      vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ status: "WAITING_UPLOAD" }));
      expect(await getImageStatus({ accessToken: "at", imageUrn: "urn:li:image:abc" })).toBe("PROCESSING");
    });
  });

  it("createPost with media sends content.media { id, altText } and keeps the commentary", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:7" } }));
    const res = await createPost({
      accessToken: "at",
      authorUrn: "urn:li:organization:1",
      commentary: "Look",
      media: { imageUrn: "urn:li:image:abc", altText: "Lighthouse over a grid" },
    });
    expect(res.postUrn).toBe("urn:li:share:7");
    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.content).toEqual({ media: { id: "urn:li:image:abc", altText: "Lighthouse over a grid" } });
    expect(body.commentary).toBe("Look");
  });

  it("createPost without media sends no content key (text + link post exactly as before)", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:8" } }));
    await createPost({ accessToken: "at", authorUrn: "urn:li:organization:1", commentary: "hi" });
    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).not.toHaveProperty("content");
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/integrations/linkedin-client.test.ts`
Expected: FAIL — the three new exports don't exist; `media` is not a known arg.

- [ ] **Step 3: Implement the client functions**

In `src/lib/integrations/linkedin/client.ts`, insert after `listAdminOrganizations` (after line 154):

```ts
// ---- Images API (native image posts, spec §8) -------------------------------
// Three-step upload: initialize (get an upload URL + image URN), PUT the bytes,
// then poll the URN until LinkedIn has processed it. The URN is what a post
// references. Same versioned-REST headers and same w_organization_social scope
// as createPost — no re-auth.

export type LinkedinImageStatus = "PROCESSING" | "AVAILABLE" | "FAILED";

export async function initializeImageUpload(args: {
  accessToken: string;
  ownerUrn: string;
}): Promise<{ uploadUrl: string; imageUrn: string }> {
  const response = await restRequest(args.accessToken, "/rest/images?action=initializeUpload", {
    method: "POST",
    body: JSON.stringify({ initializeUploadRequest: { owner: args.ownerUrn } }),
  });
  const data = (await response.json()) as { value?: { uploadUrl?: string; image?: string } };
  if (!data.value?.uploadUrl || !data.value.image) {
    throw new LinkedinApiError(response.status, "LinkedIn initializeUpload returned no uploadUrl/image.");
  }
  return { uploadUrl: data.value.uploadUrl, imageUrn: data.value.image };
}

// The upload URL is an absolute LinkedIn media-host URL, not an api.linkedin.com
// path, so it does not go through restRequest. Same bearer token; raw bytes.
// Timeouts stay plain Errors (retryable) for the same reason as restRequest.
export async function uploadImageBytes(args: { uploadUrl: string; bytes: Uint8Array; accessToken: string }): Promise<void> {
  let response: Response;
  try {
    response = await fetch(args.uploadUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${args.accessToken}`, "content-type": "application/octet-stream" },
      body: args.bytes,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string } | undefined)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`LinkedIn image upload timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  }
  if (!response.ok) {
    throw new LinkedinApiError(response.status, `LinkedIn image upload failed: HTTP ${response.status}`);
  }
}

export async function getImageStatus(args: { accessToken: string; imageUrn: string }): Promise<LinkedinImageStatus> {
  const response = await restRequest(args.accessToken, `/rest/images/${encodeURIComponent(args.imageUrn)}`);
  const data = (await response.json()) as { status?: string };
  if (data.status === "AVAILABLE") return "AVAILABLE";
  if (data.status === "FAILED") return "FAILED";
  // PROCESSING, WAITING_UPLOAD, or anything LinkedIn adds later: not ready yet.
  return "PROCESSING";
}
```

Replace `createPost` (lines 164–182):

```ts
export async function createPost(args: {
  accessToken: string;
  authorUrn: string;
  commentary: string;
  // When set, the post carries this image natively (Posts API `content.media`)
  // — a larger card than a link preview, shown instead of the link's og:image.
  // The URN comes from initializeImageUpload + uploadImageBytes and must be
  // AVAILABLE (getImageStatus) before posting.
  media?: { imageUrn: string; altText: string };
}): Promise<{ postUrn: string }> {
  const response = await restRequest(args.accessToken, "/rest/posts", {
    method: "POST",
    body: JSON.stringify({
      author: args.authorUrn,
      commentary: escapeLittleText(args.commentary),
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      ...(args.media ? { content: { media: { id: args.media.imageUrn, altText: args.media.altText } } } : {}),
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });
  const postUrn = response.headers.get("x-restli-id") ?? "";
  return { postUrn };
}
```

- [ ] **Step 4: Run the client test**

Run: `npx vitest run tests/lib/integrations/linkedin-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/integrations/linkedin/client.ts tests/lib/integrations/linkedin-client.test.ts
git commit -m "feat: linkedin client uploads images and posts them natively"
```

---

### Task 7: LinkedIn destination — native image post with retry-safe upload

**Files:**
- Modify: `src/lib/publishing/destinations/linkedin.ts` (imports lines 1–7; `deliver` lines 63–119; new helpers above `linkedinDestination`)
- Modify: `tests/lib/publishing/linkedin-destination.test.ts` (mocks lines 5–11; `beforeEach` lines 38–41; append cases)
- Modify: `tests/lib/publishing/dispatch.test.ts` (append one integration case)
- Modify: `.env.example` (after line 111 `LINKEDIN_API_VERSION=202506`)

**Interfaces:**
- Consumes: `loadCoverImagePayload` (Task 2); `initializeImageUpload`, `uploadImageBytes`, `getImageStatus`, `createPost({ media })` (Task 6); `metadata` argument + `DeliveryResult.metadata` (Task 1).
- Produces: `linkedinDestination.deliver(piece, connection, externalId, database, metadata)`:
  - no ready cover → `createPost` without media, exactly as today;
  - ready cover → download blob → initialize → upload → poll ≤5× (1 s apart, `LINKEDIN_IMAGE_POLL_INTERVAL_MS` overrides) → `createPost({ media })`; `ok` result carries `metadata: { linkedinImageUrn }`;
  - still `PROCESSING` after the polls → `{ status: "retryable", metadata: { linkedinImageUrn } }`;
  - `FAILED` after a fresh upload → `permanent`;
  - `metadata.linkedinImageUrn` present on entry → skip download/initialize/upload, poll that URN (a `FAILED` stored URN falls back to one fresh upload);
  - a `retryable` classification of any error after the URN exists carries `metadata: { linkedinImageUrn }` too, so a failed post step never re-uploads.

- [ ] **Step 1: Write the failing destination tests**

In `tests/lib/publishing/linkedin-destination.test.ts`:

Replace the mocks and imports (lines 5–11) with:

```ts
vi.mock("../../../src/lib/integrations/linkedin/token", () => ({ getValidAccessToken: vi.fn() }));
vi.mock("../../../src/lib/integrations/linkedin/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/integrations/linkedin/client")>();
  return {
    ...actual,
    createPost: vi.fn(),
    initializeImageUpload: vi.fn(),
    uploadImageBytes: vi.fn(),
    getImageStatus: vi.fn(),
  };
});
vi.mock("../../../src/lib/publishing/cover-image", () => ({ loadCoverImagePayload: vi.fn() }));
import { getValidAccessToken } from "../../../src/lib/integrations/linkedin/token";
import {
  createPost,
  initializeImageUpload,
  uploadImageBytes,
  getImageStatus,
  LinkedinApiError,
} from "../../../src/lib/integrations/linkedin/client";
import { loadCoverImagePayload } from "../../../src/lib/publishing/cover-image";
```

Replace the `beforeEach` (lines 38–41) with:

```ts
  beforeEach(() => {
    vi.mocked(getValidAccessToken).mockReset();
    vi.mocked(createPost).mockReset();
    vi.mocked(initializeImageUpload).mockReset();
    vi.mocked(uploadImageBytes).mockReset();
    vi.mocked(getImageStatus).mockReset();
    vi.mocked(loadCoverImagePayload).mockReset();
    // Default: no cover. The image tests below opt in.
    vi.mocked(loadCoverImagePayload).mockResolvedValue(null);
  });
```

Also change the existing test at line 68 ("posts commentary with the appended slug link and stores the urn") to additionally assert the old behaviour is preserved verbatim:

```ts
    expect(arg.media).toBeUndefined();
    expect(initializeImageUpload).not.toHaveBeenCalled();
```

Append a new `describe` block after the existing one (after line 112):

```ts
describe("linkedin destination — native image post", () => {
  const COVER = { url: "https://blob.example/cover.png", alt: "Lighthouse over a grid", width: 1200, height: 630 };
  const PNG = new Uint8Array([137, 80, 78, 71]);

  beforeEach(() => {
    vi.mocked(getValidAccessToken).mockReset();
    vi.mocked(createPost).mockReset();
    vi.mocked(initializeImageUpload).mockReset();
    vi.mocked(uploadImageBytes).mockReset();
    vi.mocked(getImageStatus).mockReset();
    vi.mocked(loadCoverImagePayload).mockReset();
    vi.mocked(loadCoverImagePayload).mockResolvedValue(COVER);
    vi.mocked(getValidAccessToken).mockResolvedValue("at");
    vi.mocked(initializeImageUpload).mockResolvedValue({ uploadUrl: "https://media.example/up/1", imageUrn: "urn:li:image:new" });
    vi.mocked(uploadImageBytes).mockResolvedValue(undefined);
    vi.mocked(createPost).mockResolvedValue({ postUrn: "urn:li:share:1" });
    // The only raw fetch deliver() makes itself is the blob download.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }))
    );
    // Don't actually wait between status polls.
    process.env.LINKEDIN_IMAGE_POLL_INTERVAL_MS = "0";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LINKEDIN_IMAGE_POLL_INTERVAL_MS;
  });

  it("downloads the cover, initializes, uploads, polls to AVAILABLE, then posts with media and returns the urn as metadata", async () => {
    const { database } = dbStub();
    vi.mocked(getImageStatus).mockResolvedValue("AVAILABLE");

    const result = await linkedinDestination.deliver(release(), connection(), null, database, null);

    expect(result).toEqual({ status: "ok", externalId: "urn:li:share:1", metadata: { linkedinImageUrn: "urn:li:image:new" } });
    expect(fetch).toHaveBeenCalledWith("https://blob.example/cover.png", expect.anything());
    expect(initializeImageUpload).toHaveBeenCalledWith({ accessToken: "at", ownerUrn: "urn:li:organization:1" });
    const upload = vi.mocked(uploadImageBytes).mock.calls[0][0];
    expect(upload.uploadUrl).toBe("https://media.example/up/1");
    expect(Array.from(upload.bytes)).toEqual(Array.from(PNG));
    expect(getImageStatus).toHaveBeenCalledWith({ accessToken: "at", imageUrn: "urn:li:image:new" });
    const post = vi.mocked(createPost).mock.calls[0][0];
    expect(post.media).toEqual({ imageUrn: "urn:li:image:new", altText: "Lighthouse over a grid" });
    expect(post.commentary).toBe("Hook.\n\nDetails.\n\nhttps://acme.com/changelog/new-dashboard");
  });

  it("returns retryable WITH the image urn when LinkedIn is still processing after the poll budget, and never posts", async () => {
    const { database } = dbStub();
    vi.mocked(getImageStatus).mockResolvedValue("PROCESSING");

    const result = await linkedinDestination.deliver(release(), connection(), null, database, null);

    expect(result).toEqual({
      status: "retryable",
      error: expect.stringMatching(/still processing/i),
      metadata: { linkedinImageUrn: "urn:li:image:new" },
    });
    expect(getImageStatus).toHaveBeenCalledTimes(5);
    expect(createPost).not.toHaveBeenCalled();
  });

  it("on a retry with a stored urn, skips download/initialize/upload and posts once the image is AVAILABLE", async () => {
    const { database } = dbStub();
    vi.mocked(getImageStatus).mockResolvedValue("AVAILABLE");

    const result = await linkedinDestination.deliver(release(), connection(), null, database, {
      linkedinImageUrn: "urn:li:image:stored",
    });

    expect(result).toEqual({ status: "ok", externalId: "urn:li:share:1", metadata: { linkedinImageUrn: "urn:li:image:stored" } });
    expect(fetch).not.toHaveBeenCalled();
    expect(initializeImageUpload).not.toHaveBeenCalled();
    expect(uploadImageBytes).not.toHaveBeenCalled();
    expect(vi.mocked(createPost).mock.calls[0][0].media).toEqual({ imageUrn: "urn:li:image:stored", altText: "Lighthouse over a grid" });
  });

  it("uploads fresh when the stored urn reports FAILED", async () => {
    const { database } = dbStub();
    vi.mocked(getImageStatus)
      .mockResolvedValueOnce("FAILED") // the stored urn
      .mockResolvedValue("AVAILABLE"); // the fresh one

    const result = await linkedinDestination.deliver(release(), connection(), null, database, {
      linkedinImageUrn: "urn:li:image:stored",
    });

    expect(result).toEqual({ status: "ok", externalId: "urn:li:share:1", metadata: { linkedinImageUrn: "urn:li:image:new" } });
    expect(initializeImageUpload).toHaveBeenCalledTimes(1);
    expect(uploadImageBytes).toHaveBeenCalledTimes(1);
  });

  it("returns permanent when a fresh upload reports FAILED, without posting", async () => {
    const { database } = dbStub();
    vi.mocked(getImageStatus).mockResolvedValue("FAILED");

    const result = await linkedinDestination.deliver(release(), connection(), null, database, null);

    expect(result.status).toBe("permanent");
    expect(createPost).not.toHaveBeenCalled();
  });

  it("carries the urn as metadata when the post step itself fails retryably (5xx), so the retry won't re-upload", async () => {
    const { database } = dbStub();
    vi.mocked(getImageStatus).mockResolvedValue("AVAILABLE");
    vi.mocked(createPost).mockRejectedValue(new LinkedinApiError(503, "down"));

    const result = await linkedinDestination.deliver(release(), connection(), null, database, null);

    expect(result).toEqual({ status: "retryable", error: "down", metadata: { linkedinImageUrn: "urn:li:image:new" } });
  });

  it("classifies a failed blob download as retryable and never touches the Images API", async () => {
    const { database } = dbStub();
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));

    const result = await linkedinDestination.deliver(release(), connection(), null, database, null);

    expect(result.status).toBe("retryable");
    expect(initializeImageUpload).not.toHaveBeenCalled();
    expect(createPost).not.toHaveBeenCalled();
  });

  it("still short-circuits on an existing externalId before touching the cover (post-once guard)", async () => {
    const { database } = dbStub();
    const result = await linkedinDestination.deliver(release(), connection(), "urn:li:share:existing", database, null);
    expect(result).toEqual({ status: "ok", externalId: "urn:li:share:existing" });
    expect(loadCoverImagePayload).not.toHaveBeenCalled();
  });
});
```

(`afterEach` must be added to the vitest import on line 1: `import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/lib/publishing/linkedin-destination.test.ts`
Expected: FAIL — the new describe's cases fail (`createPost` called without media, no metadata, `initializeImageUpload` never called).

- [ ] **Step 3: Implement the destination**

Replace `src/lib/publishing/destinations/linkedin.ts` lines 1–7 (imports) with:

```ts
import { and, eq, isNotNull } from "drizzle-orm";
import { linkedinConnections } from "@/db/schema";
import { getValidAccessToken } from "@/lib/integrations/linkedin/token";
import {
  createPost,
  getImageStatus,
  initializeImageUpload,
  uploadImageBytes,
  LinkedinApiError,
} from "@/lib/integrations/linkedin/client";
import { slugify } from "@/lib/publishing/slug";
import { readVariant } from "@/lib/publishing/channel-variants";
import { loadCoverImagePayload, type CoverImagePayload } from "@/lib/publishing/cover-image";
import type { Destination, DeliveryResult, DbClient, ContentPiece } from "./types";

type LinkedinConnection = typeof linkedinConnections.$inferSelect;

// How many times to ask LinkedIn whether the uploaded image is AVAILABLE
// before handing the wait to the delivery_attempts retry sweep. Uploads are
// usually ready within a second or two; five polls a second apart bounds a
// single publish action at ~5 s of waiting plus the per-request 10 s timeouts.
const IMAGE_STATUS_POLLS = 5;
function imagePollIntervalMs(): number {
  return Number(process.env.LINKEDIN_IMAGE_POLL_INTERVAL_MS ?? 1000);
}
const BLOB_FETCH_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

Insert the helpers after `classifyAndRecord` (after line 41 of the original) and before `export const linkedinDestination`:

```ts
// Fetches the cover PNG from Blob. A plain Error (not LinkedinApiError) on any
// failure so classify() treats it as retryable — Blob is a CDN, this is a
// transient network problem, never a content problem.
async function downloadCover(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(BLOB_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Could not download the cover image: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

// Polls one image URN. Returns the terminal status, or "PROCESSING" once the
// poll budget is spent — the caller turns that into `retryable` so the sweep
// picks it up later without re-uploading.
async function pollImage(accessToken: string, imageUrn: string): Promise<"AVAILABLE" | "FAILED" | "PROCESSING"> {
  for (let poll = 0; poll < IMAGE_STATUS_POLLS; poll++) {
    if (poll > 0) await sleep(imagePollIntervalMs());
    const status = await getImageStatus({ accessToken, imageUrn });
    if (status !== "PROCESSING") return status;
  }
  return "PROCESSING";
}

type PreparedCover = { ok: true; imageUrn: string } | { ok: false; result: DeliveryResult };

// Turns the cover into an AVAILABLE LinkedIn image URN, reusing the URN a
// previous attempt stored on the delivery row so a retry never uploads twice.
// Any thrown error is classified exactly like a post error, and — once a URN
// exists — a retryable classification carries it as metadata.
async function prepareCoverImage(args: {
  accessToken: string;
  ownerUrn: string;
  cover: CoverImagePayload;
  storedImageUrn: string | null;
  database: DbClient;
  connectionId: string;
}): Promise<PreparedCover> {
  let imageUrn = args.storedImageUrn;
  try {
    if (imageUrn) {
      const status = await pollImage(args.accessToken, imageUrn);
      if (status === "AVAILABLE") return { ok: true, imageUrn };
      if (status === "PROCESSING") {
        return {
          ok: false,
          result: {
            status: "retryable",
            error: "LinkedIn is still processing the cover image; will retry.",
            metadata: { linkedinImageUrn: imageUrn },
          },
        };
      }
      // FAILED: the earlier upload is dead — mint a fresh one below.
      imageUrn = null;
    }

    const bytes = await downloadCover(args.cover.url);
    const init = await initializeImageUpload({ accessToken: args.accessToken, ownerUrn: args.ownerUrn });
    imageUrn = init.imageUrn;
    await uploadImageBytes({ uploadUrl: init.uploadUrl, bytes, accessToken: args.accessToken });

    const status = await pollImage(args.accessToken, imageUrn);
    if (status === "AVAILABLE") return { ok: true, imageUrn };
    if (status === "FAILED") {
      return { ok: false, result: { status: "permanent", error: "LinkedIn could not process the cover image." } };
    }
    return {
      ok: false,
      result: {
        status: "retryable",
        error: "LinkedIn is still processing the cover image; will retry.",
        metadata: { linkedinImageUrn: imageUrn },
      },
    };
  } catch (error) {
    const result = await classifyAndRecord(error, args.database, args.connectionId);
    return { ok: false, result: withImageUrn(result, imageUrn) };
  }
}

// Attach the URN to a retryable result so the next attempt skips the upload.
// ok/permanent results are returned unchanged (ok gets its metadata at the
// post step; permanent rows are done).
function withImageUrn(result: DeliveryResult, imageUrn: string | null): DeliveryResult {
  if (imageUrn && result.status === "retryable") return { ...result, metadata: { linkedinImageUrn: imageUrn } };
  return result;
}
```

Replace `deliver` (lines 63–119 of the original) with:

```ts
  async deliver(piece: ContentPiece, connection, externalId, database, metadata): Promise<DeliveryResult> {
    // Post-once: a piece already posted to LinkedIn must never be re-posted
    // (that would duplicate/spam), unlike Webflow which updates in place.
    if (externalId) return { status: "ok", externalId };

    if (!connection.organizationUrn || !connection.baseUrl) {
      return { status: "permanent", error: "LinkedIn connection is missing an organization or base URL.", configFault: true };
    }
    // Company-only guarantee 2: never post as a personal member. The author
    // must be an organization URN; anything else is a config fault, not a post.
    if (!connection.organizationUrn.startsWith("urn:li:organization:")) {
      return { status: "permanent", error: "LinkedIn author must be an organization page.", configFault: true };
    }
    const variant = await readVariant(database, piece.id, "linkedin");
    if (!variant || !variant.body.trim()) {
      return { status: "permanent", error: "Generate a LinkedIn post before publishing." };
    }

    const link = new URL(slugify(piece.title), connection.baseUrl).toString();
    const commentary = `${variant.body.trim()}\n\n${link}`;

    // Acquire the token BEFORE the network try-block. getValidAccessToken can
    // fail two ways that must NOT be lumped in with a retryable network error:
    //   - LinkedinApiError 401/403: token dead / refresh impossible -> permanent
    //     + configFault, and mark the connection needs_reauth.
    //   - a plain Error from decryptSecret (rotated/misconfigured
    //     CREDENTIALS_ENCRYPTION_KEY): retrying can never help -> permanent +
    //     configFault. Falling through to the network classifier would retry a
    //     decrypt failure forever. Mirrors webflow.ts's decrypt guard.
    let accessToken: string;
    try {
      accessToken = await getValidAccessToken(connection, database);
    } catch (error) {
      if (isAuthFailure(error)) {
        await recordNeedsReauth(database, connection.id);
        return classify(error);
      }
      return {
        status: "permanent",
        error: "Could not obtain a LinkedIn access token. Check the connection and CREDENTIALS_ENCRYPTION_KEY.",
        configFault: true,
      };
    }

    // The cover rides along as the post's own image (spec §8): larger in the
    // feed than a link card and independent of the blog page's og:image. No
    // ready cover → text + link, exactly as before.
    const cover = await loadCoverImagePayload(piece.tenantId, piece.id, database);
    let media: { imageUrn: string; altText: string } | undefined;
    if (cover) {
      const prepared = await prepareCoverImage({
        accessToken,
        ownerUrn: connection.organizationUrn,
        cover,
        storedImageUrn: metadata?.linkedinImageUrn ?? null,
        database,
        connectionId: connection.id,
      });
      if (!prepared.ok) return prepared.result;
      media = { imageUrn: prepared.imageUrn, altText: cover.alt };
    }

    try {
      const { postUrn } = await createPost({ accessToken, authorUrn: connection.organizationUrn, commentary, media });
      if (!postUrn) {
        return {
          status: "permanent",
          error: "LinkedIn accepted the post but returned no post id; not retrying to avoid duplicating it.",
        };
      }
      return media
        ? { status: "ok", externalId: postUrn, metadata: { linkedinImageUrn: media.imageUrn } }
        : { status: "ok", externalId: postUrn };
    } catch (error) {
      const result = await classifyAndRecord(error, database, connection.id);
      return withImageUrn(result, media?.imageUrn ?? null);
    }
  },
```

- [ ] **Step 4: Run the destination test**

Run: `npx vitest run tests/lib/publishing/linkedin-destination.test.ts`
Expected: PASS (8 original + 8 new).

- [ ] **Step 5: End-to-end through dispatch: metadata persists and the sweep reuses the upload**

This is the only test that proves dispatch.ts (Task 1) actually writes `metadata` and hands it back. Append to `tests/lib/publishing/dispatch.test.ts` inside `describe("dispatch", ...)`. It seeds a real LinkedIn connection, LinkedIn variant, and cover rows, and routes a stubbed `fetch` by URL.

Extend the schema import at the top (lines 4–12) with `linkedinConnections, channelVariants, contentImages, imageRenders`.

```ts
  it("linkedin: a still-processing upload is stored as metadata and the sweep retry posts without re-uploading", async () => {
    const { tenant, update } = await seed();
    const li = encryptSecret("li-tok");
    await db.insert(linkedinConnections).values({
      tenantId: tenant.id,
      accessTokenCiphertext: li.ciphertext,
      accessTokenIv: li.iv,
      accessTokenAuthTag: li.authTag,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      organizationUrn: "urn:li:organization:1",
      baseUrl: "https://acme.com/blog/",
      status: "active",
    });
    await db.insert(channelVariants).values({ contentPieceId: update.id, channel: "linkedin", body: "Hook." });
    const [image] = await db
      .insert(contentImages)
      .values({
        tenantId: tenant.id,
        contentPieceId: update.id,
        role: "cover",
        concept: "c",
        altText: "Alt",
        sourceKind: "generated",
        status: "ready",
      })
      .returning();
    const [render] = await db
      .insert(imageRenders)
      .values({
        imageId: image.id,
        prompt: "p",
        blobUrl: "https://blob.example/cover.png",
        blobPathname: "tenants/x/cover.png",
        width: 1200,
        height: 630,
        bytes: 10,
        model: "m",
      })
      .returning();
    await db.update(contentImages).set({ currentRenderId: render.id }).where(eq(contentImages.id, image.id));
    process.env.LINKEDIN_IMAGE_POLL_INTERVAL_MS = "0";

    let initializeCalls = 0;
    let uploadCalls = 0;
    let postCalls = 0;
    let imageStatus = "PROCESSING";
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "https://blob.example/cover.png") return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      if (url.endsWith("/rest/images?action=initializeUpload")) {
        initializeCalls++;
        return jsonResponse({ value: { uploadUrl: "https://media.example/up/1", image: "urn:li:image:abc" } });
      }
      if (url === "https://media.example/up/1" && method === "PUT") {
        uploadCalls++;
        return new Response(null, { status: 201 });
      }
      if (url.includes("/rest/images/urn%3Ali%3Aimage%3Aabc")) return jsonResponse({ status: imageStatus });
      if (url.endsWith("/rest/posts") && method === "POST") {
        postCalls++;
        return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:9" } });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    try {
      await dispatchAllDestinations(update.id, db, ["linkedin"]);

      let [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
      expect(delivery.status).toBe("failed");
      expect(delivery.attempts).toBe(1);
      expect(delivery.metadata).toEqual({ linkedinImageUrn: "urn:li:image:abc" });
      expect(delivery.lastError).toMatch(/still processing/i);
      expect(initializeCalls).toBe(1);
      expect(uploadCalls).toBe(1);
      expect(postCalls).toBe(0);

      // LinkedIn finishes processing; the sweep retries and must reuse the urn.
      imageStatus = "AVAILABLE";
      await retryFailedDeliveries();

      [delivery] = await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.contentPieceId, update.id));
      expect(delivery.status).toBe("success");
      expect(delivery.attempts).toBe(2);
      expect(delivery.externalId).toBe("urn:li:share:9");
      expect(delivery.metadata).toEqual({ linkedinImageUrn: "urn:li:image:abc" });
      expect(initializeCalls).toBe(1);
      expect(uploadCalls).toBe(1);
      expect(postCalls).toBe(1);
    } finally {
      delete process.env.LINKEDIN_IMAGE_POLL_INTERVAL_MS;
    }
  });
```

Run: `npx vitest run tests/lib/publishing/dispatch.test.ts`
Expected: PASS. If it flakes once, run it again (shared Postgres); if it fails the same way twice, it's real.

- [ ] **Step 6: Document the poll interval env**

In `.env.example`, after line 111 (`LINKEDIN_API_VERSION=202506`):

```
# Milliseconds between polls of an uploaded image's status before a post
# (5 polls per attempt; a still-processing image is retried by the sweep).
# LINKEDIN_IMAGE_POLL_INTERVAL_MS=1000
```

- [ ] **Step 7: Typecheck, lint, build**

```bash
npm run typecheck && npm run lint && npm run build
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/publishing/destinations/linkedin.ts tests/lib/publishing/linkedin-destination.test.ts tests/lib/publishing/dispatch.test.ts .env.example
git commit -m "feat: linkedin posts carry the cover as a native image, retry-safe"
```

---

### Task 8: Final verification

**Files:** none new.

- [ ] **Step 1: Run every file this plan touched, twice**

```bash
npx vitest run \
  tests/db/delivery-attempts-metadata.test.ts \
  tests/lib/publishing/cover-image.test.ts \
  tests/lib/publishing/destinations/webhook.test.ts \
  tests/lib/publishing/destinations/webflow.test.ts \
  tests/lib/publishing/linkedin-destination.test.ts \
  tests/lib/publishing/dispatch.test.ts \
  tests/lib/integrations/webflow/mapping.test.ts \
  tests/lib/integrations/linkedin-client.test.ts
```

Expected: all green on at least one of two runs with no consistent failure.

- [ ] **Step 2: Whole-suite smoke + gates**

```bash
npm run typecheck && npm run lint && npm run build
npm test
```

`npm test` is flaky against the shared Postgres — a failure in a file this plan did not touch is not this plan's problem; a failure in a touched file is.

- [ ] **Step 3: Confirm the destination order** (no change expected)

`src/lib/publishing/dispatch.ts:12` must still read `[webhookDestination, webflowDestination, linkedinDestination]`.

- [ ] **Step 4: Report** — one line per destination on what a publish now sends, and whether the LinkedIn/Webflow flows were exercised only through mocks (they were; no live-API verification happened in this plan).

---

## Self-review

**Spec §8 coverage (this plan owns all of §8):**

| Spec item | Where |
|---|---|
| Body markdown carries `![alt](blob-url)`; both render paths pass `img` | Already true (`markdown-to-html.ts:6` lists `img`; `render.ts` allowlists http(s) src) — no change, noted in Task 3 payload comment |
| Webflow: `{ url, alt }` in `fieldData`, no assets API, existing Site tokens work | Task 4 (`buildFieldData` `coverImage` case), Task 5 (destination) |
| `WebflowFieldMapping` gains `{ source: "coverImage" }` | Task 4 Step 3 |
| `suggestMapping` auto-maps the first Image field | Task 4 (`imageTaken`) |
| Mapping form adds it to `SOURCE_OPTIONS` | Task 5 Step 5 (offered only on Image fields; validated server-side either way) |
| Piece without a cover: field empty → `findEmptyRequiredField` gives a clear error | Task 4 (key omitted) + Task 5 test "REQUIRED image field … no cover"; `findEmptyRequiredField` unchanged (webflow.ts:33–43 already treats `undefined` as empty) |
| Body images hotlinked in Webflow rich text | No code here; the published-piece blob-deletion exemption is Plan 1's `addRender`/`deleteImage` responsibility (brief lines 129, 135) |
| LinkedIn: initialize → PUT bytes → post with `content.media` | Task 6 (client), Task 7 (destination) |
| `createPost` gains optional `media` | Task 6 Step 3 |
| Poll `GET /rest/images/{urn}` briefly; stuck upload → `retryable` via `delivery_attempts` | Task 7 (`pollImage`, 5 × 1 s) |
| Image URN kept on the attempt row so a retry doesn't re-upload | Task 1 (`metadata` column + contract), Task 7 (`storedImageUrn` path), dispatch test in Task 7 Step 5 |
| Same `w_organization_social` scope, no re-auth | No scope change (`client.ts:6` untouched) |
| Pieces without a cover post text + link exactly as today | Task 7 test asserts `media` undefined and no Images API calls |
| Webhook: top-level `coverImage: { url, alt, width, height } \| null`, non-breaking; docs say URLs are stable/hotlinkable | Task 3 (payload + form copy) |
| Publish order (Webflow before LinkedIn) | Confirmed at `dispatch.ts:12`; Task 8 Step 3 |

**Deviations / judgement calls to flag:**

1. **`coverImage` on a non-Image field is a hard `validateMapping` error**, not a warning — `validateMapping` has no warning channel (returns `string[]` that `saveWebflowMapping` treats as blocking, actions.ts:315–316), and letting it through guarantees a Webflow 400 at publish. The form also hides the option on non-Image fields.
2. **`buildFieldData`'s slug override moved into an options object** (`{ slugOverride, cover }`) — a second trailing optional positional would have been ambiguous. One existing test call site (`mapping.test.ts:47`) and one production call site (`webflow.ts:174`) change.
3. **`Destination.deliver`'s fifth argument is optional** so webhook/webflow and their ~35 existing test call sites don't change; dispatch always passes it.
4. **A stored URN that reports `FAILED` triggers one fresh upload** rather than a `permanent` failure — otherwise a transient LinkedIn-side processing failure would strand the delivery. `FAILED` after a fresh upload is `permanent`, per the brief.
5. **`LINKEDIN_IMAGE_POLL_INTERVAL_MS`** exists so tests don't sleep 4 s per case; production default 1000 ms. Read at call site per repo convention.
6. **initializeUpload wire body** is `{ initializeUploadRequest: { owner } }` (LinkedIn's actual schema), not the spec's shorthand `{ owner }`.

**Gaps handed elsewhere:** none within §8. Blob-deletion exemptions for published pieces (spec §3/§7) and cover generation itself belong to Plans 1–3.
