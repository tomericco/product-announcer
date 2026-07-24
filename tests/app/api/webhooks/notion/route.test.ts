import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../../../../src/db";
import { tenants, notionConnections } from "../../../../../src/db/schema";
import { encryptSecret } from "../../../../../src/lib/credentials/encryption";

const TOKEN = "verif-token";
const TENANT = "Notion Webhook Route Test Tenant";
process.env.CREDENTIALS_ENCRYPTION_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY ?? "a".repeat(64);

vi.mock("../../../../../src/lib/change-events/ingest-notion-task", () => ({
  ingestNotionTask: vi.fn(async () => {}),
}));
vi.mock("../../../../../src/lib/integrations/notion/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../src/lib/integrations/notion/client")>();
  return { ...actual, getPage: vi.fn() };
});

import { POST, processNotionEvent } from "../../../../../src/app/api/webhooks/notion/route";
import { ingestNotionTask } from "../../../../../src/lib/change-events/ingest-notion-task";
import { getPage } from "../../../../../src/lib/integrations/notion/client";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", TOKEN).update(body).digest("hex");
}
function post(body: string, signed = true): Request {
  return new Request("https://app.example.com/api/webhooks/notion", {
    method: "POST",
    body,
    headers: signed ? { "x-notion-signature": sign(body) } : {},
  });
}

async function seedConnection(): Promise<string> {
  const [tenant] = await db.insert(tenants).values({ name: TENANT }).returning({ id: tenants.id });
  const at = encryptSecret("access");
  await db.insert(notionConnections).values({
    tenantId: tenant.id,
    accessTokenCiphertext: at.ciphertext,
    accessTokenIv: at.iv,
    accessTokenAuthTag: at.authTag,
    workspaceId: "ws-1",
    databaseId: "db-1",
    statusPropertyId: "prop-status",
    statusPropertyName: "Status",
    doneValues: ["Done"],
    status: "active",
  });
  return tenant.id;
}

describe("notion webhook route", () => {
  beforeAll(() => {
    process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN = TOKEN;
  });
  afterAll(() => {
    delete process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN;
  });
  afterEach(async () => {
    vi.mocked(ingestNotionTask).mockClear();
    vi.mocked(getPage).mockReset();
    await db.delete(tenants).where(eq(tenants.name, TENANT));
  });

  it("rejects a bad signature with 401", async () => {
    const res = await POST(post("{}", false) as never);
    expect(res.status).toBe(401);
  });

  it("200s and logs on a verification handshake", async () => {
    const res = await POST(post(JSON.stringify({ verification_token: "vt" })) as never);
    expect(res.status).toBe(200);
  });

  it("200s and ignores a non page.properties_updated event", async () => {
    await seedConnection();
    const res = await POST(post(JSON.stringify({ type: "page.created", workspace_id: "ws-1" })) as never);
    expect(res.status).toBe(200);
  });

  // processNotionEvent covers steps 4-9 (the deferred body).
  it("drops an unknown workspace without calling getPage", async () => {
    await processNotionEvent({
      type: "page.properties_updated",
      workspace_id: "ws-unknown",
      entity: { id: "page-1" },
      data: { updated_properties: ["prop-status"] },
    });
    expect(getPage).not.toHaveBeenCalled();
    expect(ingestNotionTask).not.toHaveBeenCalled();
  });

  it("cheap-rejects when the status property was not among updated_properties (no getPage)", async () => {
    await seedConnection();
    await processNotionEvent({
      type: "page.properties_updated",
      workspace_id: "ws-1",
      entity: { id: "page-1" },
      data: { updated_properties: ["some-other-prop"] },
    });
    expect(getPage).not.toHaveBeenCalled();
    expect(ingestNotionTask).not.toHaveBeenCalled();
  });

  it("stops when the status value is not in doneValues", async () => {
    await seedConnection();
    vi.mocked(getPage).mockResolvedValue({
      url: "https://notion.so/page-1",
      title: "T",
      description: "d",
      statusByPropertyId: { "prop-status": "In progress" },
    });
    await processNotionEvent({
      type: "page.properties_updated",
      workspace_id: "ws-1",
      entity: { id: "page-1" },
      data: { updated_properties: ["prop-status"] },
    });
    expect(ingestNotionTask).not.toHaveBeenCalled();
  });

  it("ingests a completed task", async () => {
    const tid = await seedConnection();
    vi.mocked(getPage).mockResolvedValue({
      url: "https://notion.so/page-1",
      title: "Add dark mode",
      description: "Toggle a dark theme.",
      statusByPropertyId: { "prop-status": "Done" },
    });
    await processNotionEvent({
      type: "page.properties_updated",
      workspace_id: "ws-1",
      entity: { id: "page-1" },
      data: { updated_properties: ["prop-status"] },
      timestamp: "2026-07-24T10:00:00.000Z",
    });
    expect(ingestNotionTask).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(ingestNotionTask).mock.calls[0][0];
    expect(arg).toMatchObject({ tenantId: tid, pageId: "page-1", title: "Add dark mode", url: "https://notion.so/page-1" });
  });
});
