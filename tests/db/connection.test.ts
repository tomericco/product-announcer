import { describe, expect, it } from "vitest";
import { resolveConnectionString } from "@/db/connection";

describe("resolveConnectionString", () => {
  it("prefers DATABASE_URL when both are set", () => {
    const result = resolveConnectionString({
      DATABASE_URL: "postgresql://local/dev",
      POSTGRES_URL: "postgresql://supabase/prod",
    } as unknown as NodeJS.ProcessEnv);
    expect(result).toBe("postgresql://local/dev");
  });

  it("falls back to POSTGRES_URL when DATABASE_URL is absent", () => {
    const result = resolveConnectionString({
      POSTGRES_URL: "postgresql://supabase/prod",
    } as unknown as NodeJS.ProcessEnv);
    expect(result).toBe("postgresql://supabase/prod");
  });

  it("falls back to POSTGRES_URL when DATABASE_URL is an empty string", () => {
    const result = resolveConnectionString({
      DATABASE_URL: "",
      POSTGRES_URL: "postgresql://supabase/prod",
    } as unknown as NodeJS.ProcessEnv);
    expect(result).toBe("postgresql://supabase/prod");
  });

  it("returns undefined when neither is set", () => {
    expect(resolveConnectionString({} as unknown as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
