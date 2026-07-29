import { describe, expect, it } from "vitest";
import { normalizeConnectionString, resolveConnectionString } from "@/db/connection";

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

describe("normalizeConnectionString", () => {
  it("rewrites sslmode=require to sslmode=no-verify", () => {
    const result = normalizeConnectionString(
      "postgres://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require"
    );
    expect(result).toBe(
      "postgres://u:p@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=no-verify"
    );
  });

  it("preserves other query parameters alongside the rewrite", () => {
    const result = normalizeConnectionString(
      "postgres://u:p@host:6543/postgres?sslmode=require&supa=base-pooler.x"
    );
    expect(result).toBe(
      "postgres://u:p@host:6543/postgres?sslmode=no-verify&supa=base-pooler.x"
    );
  });

  it("leaves a URL without sslmode untouched", () => {
    const local = "postgresql://postgres:postgres@localhost:5434/product_announcer";
    expect(normalizeConnectionString(local)).toBe(local);
  });

  it("does not override an explicit sslmode=verify-full", () => {
    const strict = "postgres://u:p@host:5432/postgres?sslmode=verify-full";
    expect(normalizeConnectionString(strict)).toBe(strict);
  });

  it("passes undefined through", () => {
    expect(normalizeConnectionString(undefined)).toBeUndefined();
  });
});

describe("resolveConnectionString normalization", () => {
  it("returns a normalized URL when the resolved value needs it", () => {
    const result = resolveConnectionString({
      NODE_ENV: "test",
      POSTGRES_URL: "postgres://u:p@host:6543/postgres?sslmode=require&supa=base-pooler.x",
    });
    expect(result).toBe(
      "postgres://u:p@host:6543/postgres?sslmode=no-verify&supa=base-pooler.x"
    );
  });

  it("leaves a local DATABASE_URL untouched", () => {
    const local = "postgresql://postgres:postgres@localhost:5434/product_announcer";
    const result = resolveConnectionString({ NODE_ENV: "test", DATABASE_URL: local });
    expect(result).toBe(local);
  });
});
