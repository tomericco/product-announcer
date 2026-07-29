import { describe, expect, it } from "vitest";
import { resolveConnectionString } from "@/db/connection";

describe("resolveConnectionString", () => {
  it("prefers DATABASE_URL when both are set", () => {
    const result = resolveConnectionString({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://local/dev",
      POSTGRES_URL: "postgresql://supabase/prod",
    });
    expect(result).toBe("postgresql://local/dev");
  });

  it("falls back to POSTGRES_URL when DATABASE_URL is absent", () => {
    const result = resolveConnectionString({
      NODE_ENV: "test",
      POSTGRES_URL: "postgresql://supabase/prod",
    });
    expect(result).toBe("postgresql://supabase/prod");
  });

  it("falls back to POSTGRES_URL when DATABASE_URL is an empty string", () => {
    const result = resolveConnectionString({
      NODE_ENV: "test",
      DATABASE_URL: "",
      POSTGRES_URL: "postgresql://supabase/prod",
    });
    expect(result).toBe("postgresql://supabase/prod");
  });

  it("returns undefined when neither is set", () => {
    expect(resolveConnectionString({ NODE_ENV: "test" })).toBeUndefined();
  });
});
