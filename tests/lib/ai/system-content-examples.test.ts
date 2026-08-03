import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../../src/db";
import { systemContentExamples } from "../../../src/db/schema";

describe("system_content_examples seed", () => {
  it("seeds a matchable catalog of at least 12 examples", async () => {
    const all = await db.select().from(systemContentExamples);
    expect(all.length).toBeGreaterThanOrEqual(12);
    // every seeded row must be matchable: it has an industry or a persona_key
    expect(all.every((e) => e.industry !== null || e.personaKey !== null)).toBe(true);
  });

  it("includes the devtools/developer/new exemplar with the expected tags", async () => {
    const [row] = await db
      .select()
      .from(systemContentExamples)
      .where(eq(systemContentExamples.key, "devtools-developer-new"));
    expect(row).toBeDefined();
    expect(row.industry).toBe("Developer Tools");
    expect(row.personaKey).toBe("developer");
    expect(row.contentType).toBe("product_update");
    expect(row.category).toBe("new");
    expect(row.title.length).toBeGreaterThan(0);
    expect(row.body.length).toBeGreaterThan(0);
  });
});
