import { pgTable, pgEnum, uuid, text, timestamp, primaryKey, integer } from "drizzle-orm/pg-core";

export const tenantRoleEnum = pgEnum("tenant_role", ["owner", "member"]);

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  githubInstallationId: text("github_installation_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  name: text("name"),
  githubId: text("github_id").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tenantMembers = pgTable(
  "tenant_members",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: tenantRoleEnum("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.userId] })]
);

export const sourceTypeEnum = pgEnum("source_type", ["pr", "commit"]);
export const changeItemStatusEnum = pgEnum("change_item_status", ["pending", "batched", "excluded"]);

export const repos = pgTable("repos", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  githubRepoFullName: text("github_repo_full_name").notNull(),
  githubInstallationId: text("github_installation_id").notNull(),
  watchedBranch: text("watched_branch").notNull(),
  sourceTypes: text("source_types").array().notNull().default(["pr"]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const changeItems = pgTable("change_items", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  repoId: uuid("repo_id")
    .notNull()
    .references(() => repos.id, { onDelete: "cascade" }),
  sourceType: sourceTypeEnum("source_type").notNull(),
  status: changeItemStatusEnum("status").notNull().default("pending"),
  // No FK yet — the `updates` table is created in Plan 3, which adds the reference.
  updateId: uuid("update_id"),
  excludedAt: timestamp("excluded_at", { withTimezone: true }),
  excludedBy: uuid("excluded_by").references(() => users.id),
  // pr-sourced fields
  prNumber: integer("pr_number"),
  prTitle: text("pr_title"),
  prDescription: text("pr_description"),
  prUrl: text("pr_url"),
  mergedAt: timestamp("merged_at", { withTimezone: true }),
  // commit-sourced fields
  commitSha: text("commit_sha"),
  commitMessage: text("commit_message"),
  diff: text("diff"),
  commitUrl: text("commit_url"),
  committedAt: timestamp("committed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
