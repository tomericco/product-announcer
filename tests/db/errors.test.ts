import { describe, it, expect, afterEach } from "vitest";
import { db } from "../../src/db";
import { aiVisibilityPrompts } from "../../src/db/schema";
import { isUniqueViolation } from "../../src/db/errors";
import { seedTenant, dropTenant } from "../helpers/fixtures";

const TENANT = "Db Errors Test Tenant";

afterEach(async () => {
  await dropTenant(TENANT);
});

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

describe("isUniqueViolation", () => {
  it("recognises a bare driver error", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("walks the cause chain, however deeply the error is wrapped", () => {
    // Drizzle wraps the driver error in a DrizzleQueryError and hangs the
    // original off `.cause`. Assuming exactly one level of wrapping is how
    // this stops working the next time a layer is added.
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation({ cause: { cause: { cause: { code: "23505" } } } })).toBe(true);
  });

  it("does not blame the wording for a failure that is not a collision", () => {
    // The whole point of the function: a foreign-key violation, a deadlock, a
    // statement timeout and a plain bug must not be reported as "you already
    // have one of these".
    expect(isUniqueViolation({ code: "23503" })).toBe(false); // foreign_key_violation
    expect(isUniqueViolation({ code: "40P01" })).toBe(false); // deadlock_detected
    expect(isUniqueViolation({ code: "57014" })).toBe(false); // query_canceled
    expect(isUniqueViolation({ code: "23502" })).toBe(false); // not_null_violation
    expect(isUniqueViolation(new Error("connection terminated unexpectedly"))).toBe(false);
    expect(isUniqueViolation({ cause: { code: "23503" } })).toBe(false);
  });

  it("survives anything that is not an error object", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    expect(isUniqueViolation(23505)).toBe(false);
    expect(isUniqueViolation({})).toBe(false);
    expect(isUniqueViolation({ cause: null })).toBe(false);
  });

  it("matches what Postgres and drizzle actually throw for a collision", async () => {
    const tenant = await seedTenant(TENANT);
    const row = {
      tenantId: tenant.id,
      text: "best issue trackers",
      intent: "discovery",
      origin: "user" as const,
      status: "active" as const,
    };
    await db.insert(aiVisibilityPrompts).values(row);

    // The real error, through the real wrapper, rather than a hand-built
    // shape that happens to agree with the implementation.
    const error = await caught(() => db.insert(aiVisibilityPrompts).values(row));

    expect(isUniqueViolation(error)).toBe(true);
  });

  it("returns false for a real foreign-key failure from the same driver", async () => {
    const error = await caught(() =>
      db.insert(aiVisibilityPrompts).values({
        tenantId: "00000000-0000-4000-8000-000000000000",
        text: "a prompt for a tenant that does not exist",
        intent: "discovery",
        origin: "user",
        status: "active",
      })
    );

    expect(isUniqueViolation(error)).toBe(false);
  });
});
