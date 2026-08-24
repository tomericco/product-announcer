import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { aiVisibilityPrompts, companyProfiles, competitors, tenants } from "../../../src/db/schema";
import { preflightRun, type PreflightCheckId } from "../../../src/lib/ai-visibility/preflight";
import { planRun } from "../../../src/lib/ai-visibility/run";
import { setAiVisibilityEnabled } from "../../../src/lib/ai-visibility/settings";
import { seedTenant, dropTenant, seedEngineKey, seedCompanyProfile } from "../../helpers/fixtures";

/**
 * The readiness gate: what a run needs that is not the run itself.
 *
 * Every case below is a way the OLD code spent a tenant's engine budget and
 * returned nothing for it — and, in the judge's case, wedged the workspace so
 * no future run could start either. The tests are written against the states
 * that produce them rather than against the sentences, so a reworded message
 * does not fail them but a lost check does.
 */

const TENANT = "AI Visibility Preflight Test Tenant";

/** A fully set-up workspace: everything below narrows it to one missing thing. */
async function seedReadyTenant(name = TENANT) {
  const tenant = await seedTenant(name);
  await seedEngineKey(tenant.id, "openai");
  await seedCompanyProfile(tenant.id, { websiteUrl: "https://versional.ai" });
  await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival", websiteUrl: "https://rival.com" });
  return tenant;
}

function ids(items: { id: PreflightCheckId }[]): PreflightCheckId[] {
  return items.map((item) => item.id);
}

beforeEach(() => {
  // Present by default: the judge check reads the environment, and a machine
  // that happens to have no key would otherwise fail every unrelated case here.
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-judge-key");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await dropTenant(TENANT);
});

describe("preflightRun — a ready workspace", () => {
  it("reports nothing when everything a run needs is in place", async () => {
    await seedReadyTenant();

    const result = await preflightRun((await db.select().from(tenants).where(eq(tenants.name, TENANT)))[0].id);

    expect(result.items).toEqual([]);
    expect(result.blocked).toBe(false);
  });
});

describe("preflightRun — blocks", () => {
  it("blocks with no usable engine key", async () => {
    const tenant = await seedTenant(TENANT);
    await seedCompanyProfile(tenant.id, { websiteUrl: "https://versional.ai" });
    await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" });

    const result = await preflightRun(tenant.id);

    expect(ids(result.blocks)).toContain("engine_keys");
    expect(result.blocked).toBe(true);
  });

  it("blocks when the answer judge has no credential — the run would never finish", async () => {
    // The worst of the three. Judging happens AFTER every engine answer is
    // bought, `finalizeRun` leaves the run `running` while any sample is
    // unjudged, and `planRun` refuses `run_in_flight` — so without this check
    // the workspace spends a full run and is then permanently unable to start
    // another.
    const tenant = await seedReadyTenant();
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const result = await preflightRun(tenant.id);

    expect(ids(result.blocks)).toEqual(["judge"]);
  });

  it("treats a whitespace-only judge key as absent", async () => {
    const tenant = await seedReadyTenant();
    vi.stubEnv("ANTHROPIC_API_KEY", "   ");

    expect(ids((await preflightRun(tenant.id)).blocks)).toEqual(["judge"]);
  });

  it("blocks a brand name too short to match, which no 'is it set' check would catch", async () => {
    // `tenants.name` is NOT NULL and auto-derived at signup, so the interesting
    // case is not absence — it is a name `buildAliases` throws away. A
    // one-character workspace produces zero aliases, every answer extracts zero
    // mentions, and the dashboard reports a confident 0% mention rate that
    // looks exactly like a real reading.
    const tenant = await seedReadyTenant();
    await db.update(tenants).set({ name: "X" }).where(eq(tenants.id, tenant.id));

    const result = await preflightRun(tenant.id);

    expect(ids(result.blocks)).toEqual(["brand_name"]);

    // Renamed back for the teardown, which finds the tenant by name.
    await db.update(tenants).set({ name: TENANT }).where(eq(tenants.id, tenant.id));
  });

  it("orders blocks so the first one is the thing to fix first", async () => {
    const tenant = await seedTenant(TENANT);
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const result = await preflightRun(tenant.id);

    // A key is missing before a judge is: the page shows `blocks[0]` under the
    // disabled button, and telling somebody about our judge configuration
    // before telling them they have connected no engine is the wrong order.
    expect(ids(result.blocks)).toEqual(["engine_keys", "judge"]);
  });
});

describe("preflightRun — warnings", () => {
  it("warns, without blocking, when there is no company website to attribute citations to", async () => {
    const tenant = await seedTenant(TENANT);
    await seedEngineKey(tenant.id, "openai");
    await seedCompanyProfile(tenant.id, { websiteUrl: null });
    await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" });

    const result = await preflightRun(tenant.id);

    expect(ids(result.items)).toEqual(["own_domain"]);
    expect(result.blocked).toBe(false);
  });

  it("warns on a website that is not a parseable domain, not merely on an absent one", async () => {
    // `loadBrandTargets` runs the same conversion and keeps `ownDomain: null`
    // when it fails, so a string nobody can turn into a domain buys exactly as
    // little as no website at all — and a bare "is it set" check would have
    // called this workspace ready.
    const tenant = await seedTenant(TENANT);
    await seedEngineKey(tenant.id, "openai");
    await seedCompanyProfile(tenant.id, { websiteUrl: "not a url" });
    await db.insert(competitors).values({ tenantId: tenant.id, name: "Rival" });

    expect(ids((await preflightRun(tenant.id)).items)).toEqual(["own_domain"]);
  });

  it("warns when there is nobody to benchmark against", async () => {
    const tenant = await seedTenant(TENANT);
    await seedEngineKey(tenant.id, "openai");
    await seedCompanyProfile(tenant.id, { websiteUrl: "https://versional.ai" });

    expect(ids((await preflightRun(tenant.id)).items)).toEqual(["competitors"]);
  });

  it("warns when the profile was edited after the active prompts were approved", async () => {
    const tenant = await seedReadyTenant();
    await db.insert(aiVisibilityPrompts).values({
      tenantId: tenant.id,
      text: "best localization tools",
      intent: "discovery",
      origin: "generated",
      status: "active",
      approvedAt: new Date("2026-08-01T00:00:00Z"),
    });
    await db
      .update(companyProfiles)
      .set({ updatedAt: new Date("2026-08-10T00:00:00Z") })
      .where(eq(companyProfiles.tenantId, tenant.id));

    expect(ids((await preflightRun(tenant.id)).items)).toEqual(["profile_stale"]);
  });

  it("does not call prompts stale when the profile predates their approval", async () => {
    const tenant = await seedReadyTenant();
    await db.insert(aiVisibilityPrompts).values({
      tenantId: tenant.id,
      text: "best localization tools",
      intent: "discovery",
      origin: "generated",
      status: "active",
      approvedAt: new Date("2026-08-20T00:00:00Z"),
    });
    await db
      .update(companyProfiles)
      .set({ updatedAt: new Date("2026-08-10T00:00:00Z") })
      .where(eq(companyProfiles.tenantId, tenant.id));

    expect((await preflightRun(tenant.id)).items).toEqual([]);
  });

  it("measures staleness against ACTIVE prompts only — a proposal is not what a run asks", async () => {
    const tenant = await seedReadyTenant();
    await db.insert(aiVisibilityPrompts).values({
      tenantId: tenant.id,
      text: "drafted, never approved",
      intent: "discovery",
      origin: "generated",
      status: "proposed",
      approvedAt: new Date("2026-08-01T00:00:00Z"),
    });
    await db
      .update(companyProfiles)
      .set({ updatedAt: new Date("2026-08-10T00:00:00Z") })
      .where(eq(companyProfiles.tenantId, tenant.id));

    expect((await preflightRun(tenant.id)).items).toEqual([]);
  });
});

describe("preflightRun — ordering and shape", () => {
  it("puts every block before every warning, so the list reads worst-first", async () => {
    const tenant = await seedTenant(TENANT);

    const result = await preflightRun(tenant.id);

    const levels = result.items.map((item) => item.level);
    expect(levels.indexOf("warn")).toBeGreaterThan(levels.lastIndexOf("block"));
    expect(ids(result.items)).toEqual(["engine_keys", "own_domain", "competitors"]);
  });

  it("gives every fixable item somewhere to go, and the judge none", async () => {
    const tenant = await seedTenant(TENANT);
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const result = await preflightRun(tenant.id);

    for (const item of result.items) {
      // The judge is OUR configuration. A link to a page that cannot resolve it
      // would be worse than no link.
      if (item.id === "judge") expect(item.fix).toBeNull();
      else expect(item.fix?.href, `${item.id} has nowhere to go`).toBeTruthy();
    }
  });
});

describe("planRun refuses on a preflight block", () => {
  /** A workspace that would otherwise plan: on, keyed, and holding one prompt. */
  async function seedRunnableTenant() {
    const tenant = await seedReadyTenant();
    await setAiVisibilityEnabled(tenant.id, true);
    await db.insert(aiVisibilityPrompts).values({
      tenantId: tenant.id,
      text: "best localization tools",
      intent: "discovery",
      origin: "generated",
      status: "active",
      approvedAt: new Date("2026-08-01T00:00:00Z"),
    });
    return tenant;
  }

  it("does not plan a single sample row when the judge is unreachable", async () => {
    const tenant = await seedRunnableTenant();
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const planned = await planRun(tenant.id, { trigger: "manual", now: () => new Date() });

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.reason).toBe("not_ready");
    if (planned.reason !== "not_ready") return;
    expect(ids(planned.blocks)).toEqual(["judge"]);
  });

  it("plans normally once the same workspace is ready", async () => {
    const tenant = await seedRunnableTenant();

    const planned = await planRun(tenant.id, { trigger: "manual", now: () => new Date() });

    expect(planned.ok).toBe(true);
  });
});
