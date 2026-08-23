import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db";
import { tenants, aiVisibilitySettings } from "../../src/db/schema";
import { seedTenant, dropTenant } from "../helpers/fixtures";

/**
 * `saveAiVisibilityConfig` — the /settings card's write. The form mocks it, so
 * without this file the FormData→settings mapping was covered nowhere: every
 * field name is a string on both sides of a boundary TypeScript cannot check,
 * and a typo in one of them is a setting that silently never saves.
 */
let currentTenantId = "";
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: "user-1", role: "owner" } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { saveAiVisibilityConfig } from "../../src/app/(dashboard)/settings/actions";
import { setAiVisibilityEnabled } from "../../src/lib/ai-visibility/settings";
import { revalidatePath } from "next/cache";

const TENANT = "AI Visibility Settings Action Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
  vi.clearAllMocks();
});

/** Exactly what `AiVisibilityForm` posts: Selects, hidden inputs, one number. */
function form(fields: {
  cadence?: string;
  dayOfWeek?: string;
  engines?: string[];
  samplesPerPrompt?: string;
  monthlyCapUsd?: string;
}) {
  const data = new FormData();
  data.set("cadence", fields.cadence ?? "weekly");
  data.set("dayOfWeek", fields.dayOfWeek ?? "1");
  for (const engine of fields.engines ?? ["openai", "gemini"]) data.append("engines", engine);
  data.set("samplesPerPrompt", fields.samplesPerPrompt ?? "3");
  data.set("monthlyCapUsd", fields.monthlyCapUsd ?? "20");
  return data;
}

async function stored(tenantId: string) {
  const [row] = await db
    .select()
    .from(aiVisibilitySettings)
    .where(eq(aiVisibilitySettings.tenantId, tenantId));
  return row;
}

describe("saveAiVisibilityConfig", () => {
  it("maps every field the form posts onto the row", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;

    await saveAiVisibilityConfig(
      form({
        cadence: "fortnightly",
        dayOfWeek: "4",
        engines: ["openai", "gemini", "anthropic"],
        samplesPerPrompt: "5",
        monthlyCapUsd: "45",
      })
    );

    const row = await stored(tenant.id);
    expect(row.cadence).toBe("fortnightly");
    expect(row.dayOfWeek).toBe(4);
    expect(row.engines).toEqual(["openai", "gemini", "anthropic"]);
    expect(row.samplesPerPrompt).toBe(5);
    expect(row.monthlyCapUsd).toBe(45);
  });

  it("saves the day even when the cadence is off, so the schedule survives being paused", async () => {
    // The day Select unmounts at cadence "off" and the form posts a hidden
    // input in its place. If that value did not reach here, turning the
    // schedule back on would silently start from Sunday.
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;

    await saveAiVisibilityConfig(form({ cadence: "off", dayOfWeek: "6" }));

    const row = await stored(tenant.id);
    expect(row.cadence).toBe("off");
    expect(row.dayOfWeek).toBe(6);
  });

  it("never touches `enabled` — that switch lives on the Company card", async () => {
    // Widening this action is how a Settings save would silently turn a
    // feature back on that somebody deliberately switched off.
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    await setAiVisibilityEnabled(tenant.id, false);

    await saveAiVisibilityConfig(form({ cadence: "weekly" }));

    expect((await stored(tenant.id)).enabled).toBe(false);
  });

  it("keeps `enabled` true for a workspace that had it on", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;
    await setAiVisibilityEnabled(tenant.id, true);

    await saveAiVisibilityConfig(form({ samplesPerPrompt: "1" }));

    const row = await stored(tenant.id);
    expect(row.enabled).toBe(true);
    expect(row.samplesPerPrompt).toBe(1);
  });

  it("throws naming the field, so the form's success toast does not fire on a failed save", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;

    await expect(saveAiVisibilityConfig(form({ monthlyCapUsd: "600" }))).rejects.toThrow(
      "Invalid monthlyCapUsd"
    );
    await expect(saveAiVisibilityConfig(form({ cadence: "daily" }))).rejects.toThrow("Invalid cadence");
    await expect(saveAiVisibilityConfig(form({ engines: [] }))).rejects.toThrow("Invalid engines");
    await expect(saveAiVisibilityConfig(form({ samplesPerPrompt: "2" }))).rejects.toThrow(
      "Invalid samplesPerPrompt"
    );
    await expect(saveAiVisibilityConfig(form({ dayOfWeek: "9" }))).rejects.toThrow("Invalid dayOfWeek");
  });

  it("writes nothing at all when it throws", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;

    await expect(saveAiVisibilityConfig(form({ monthlyCapUsd: "0" }))).rejects.toThrow();

    expect(await stored(tenant.id)).toBeUndefined();
  });

  it("revalidates both surfaces the settings change", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;

    await saveAiVisibilityConfig(form({}));

    expect(vi.mocked(revalidatePath).mock.calls.flat()).toEqual(
      expect.arrayContaining(["/settings", "/ai-visibility"])
    );
  });

  it("does not revalidate after a rejected save", async () => {
    const tenant = await seedTenant(TENANT);
    currentTenantId = tenant.id;

    await expect(saveAiVisibilityConfig(form({ cadence: "daily" }))).rejects.toThrow();

    expect(vi.mocked(revalidatePath)).not.toHaveBeenCalled();
  });

  it("writes only the calling tenant's row", async () => {
    const tenant = await seedTenant(TENANT);
    const [other] = await db.insert(tenants).values({ name: `${TENANT} (Other)` }).returning();
    currentTenantId = other.id;
    await saveAiVisibilityConfig(form({ cadence: "off" }));

    currentTenantId = tenant.id;
    await saveAiVisibilityConfig(form({ cadence: "fortnightly" }));

    expect((await stored(other.id)).cadence).toBe("off");
    await db.delete(tenants).where(eq(tenants.id, other.id));
  });
});
