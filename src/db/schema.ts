import { pgTable, pgEnum, uuid, text, timestamp, primaryKey, integer, jsonb, uniqueIndex, boolean, real } from "drizzle-orm/pg-core";

// A persona in a tenant's brand profile is either a live reference to a seeded
// system persona (resolved against `system_personas` at read time) or a
// self-contained custom persona the user wrote.
export type SystemPersonaRef = { type: "system"; key: string };
export type CustomPersona = { type: "custom"; name: string; brief: string };
export type PersonaRef = SystemPersonaRef | CustomPersona;

// The flattened shape consumed by the generation prompt and the settings UI.
export type ResolvedPersona = { name: string; brief: string; description?: string };

export const tenantRoleEnum = pgEnum("tenant_role", ["owner", "member"]);

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  githubInstallationId: text("github_installation_id"),
  onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
  autoPublish: boolean("auto_publish").notNull().default(false),
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
export const changeItemStatusEnum = pgEnum("change_item_status", ["pending", "batched", "excluded", "ignored"]);
export const ignoredReasonEnum = pgEnum("ignored_reason", ["merge_commit", "empty_diff"]);
export const cadenceEnum = pgEnum("cadence", ["daily", "weekly", "biweekly", "monthly", "none"]);
export const updateStatusEnum = pgEnum("update_status", ["draft", "approved", "published", "rejected"]);
// "revised" is legacy and no longer written: a draft that needed a revision is
// now recorded as "passed" (the distinction wasn't actionable). Kept in the enum
// only because Postgres has no DROP VALUE -- removing it would mean recreating
// the type and re-pointing the column for no functional gain.
export const reviewStatusEnum = pgEnum("review_status", ["passed", "revised", "failed", "error"]);
export const updateCategoryEnum = pgEnum("update_category", ["new", "improved", "fixed"]);

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

export const changeItems = pgTable(
  "change_items",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    sourceType: sourceTypeEnum("source_type").notNull(),
    status: changeItemStatusEnum("status").notNull().default("pending"),
    ignoredReason: ignoredReasonEnum("ignored_reason"),
    updateId: uuid("update_id").references(() => updates.id),
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
    // enrichment (sub-project A): classifier output, null until enriched
    userFacing: boolean("user_facing"),
    impactSummary: text("impact_summary"),
    suggestedCategory: updateCategoryEnum("suggested_category"),
    enrichmentConfidence: real("enrichment_confidence"),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("change_items_repo_pr_unique").on(table.repoId, table.prNumber),
    uniqueIndex("change_items_repo_commit_unique").on(table.repoId, table.commitSha),
  ]
);

export const scheduleConfigs = pgTable("schedule_configs", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: "cascade" }),
  cadence: cadenceEnum("cadence").notNull().default("weekly"),
  threshold: integer("threshold"),
  // Whether the threshold trigger is active. Off by default so a bulk import
  // doesn't auto-generate a draft ahead of the scheduled cadence; the threshold
  // number above is retained regardless, so re-enabling restores it.
  thresholdEnabled: boolean("threshold_enabled").notNull().default(false),
  // Time-of-day (0-23, UTC) the scheduled update is generated. Applies to every
  // cadence except "none".
  hour: integer("hour").notNull().default(9),
  // Weekday (0=Sunday … 6=Saturday) for the weekly cadence; null otherwise.
  dayOfWeek: integer("day_of_week"),
  // Calendar day (1-31) for the monthly cadence; null otherwise.
  dayOfMonth: integer("day_of_month"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  nextScheduledAt: timestamp("next_scheduled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const brandProfiles = pgTable("brand_profiles", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: "cascade" }),
  tone: text("tone"),
  readingLevel: text("reading_level"),
  doList: text("do_list").array().notNull().default([]),
  dontList: text("dont_list").array().notNull().default([]),
  examplePhrases: text("example_phrases").array().notNull().default([]),
  industry: text("industry"),
  updatesPageUrl: text("updates_page_url"),
  updatesStyleSummary: text("updates_style_summary"),
  userPersonas: jsonb("user_personas").$type<PersonaRef[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Global, seeded catalog of built-in personas. Tenants reference these by `key`
// from their brand profile; the brief steers how updates are written for them.
export const systemPersonas = pgTable("system_personas", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  brief: text("brief").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Global, seeded catalog of example product updates. Selected at generation time
// by industry/persona match and injected into the prompt as few-shot exemplars.
export const systemUpdateExamples = pgTable("system_update_examples", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  key: text("key").notNull().unique(),
  industry: text("industry"),
  personaKey: text("persona_key"),
  category: updateCategoryEnum("category").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const updates = pgTable("updates", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  repoId: uuid("repo_id").references(() => repos.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  status: updateStatusEnum("status").notNull().default("draft"),
  sourceItems: jsonb("source_items").$type<string[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  editedBy: uuid("edited_by").references(() => users.id),
  reviewStatus: reviewStatusEnum("review_status"),
  reviewIssues: jsonb("review_issues").$type<string[]>().notNull().default([]),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
});

export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", ["pending", "success", "failed"]);

export const webhookConfigs = pgTable("webhook_configs", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  secret: text("secret").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  updateId: uuid("update_id")
    .notNull()
    .references(() => updates.id, { onDelete: "cascade" }),
  webhookConfigId: uuid("webhook_config_id")
    .notNull()
    .references(() => webhookConfigs.id, { onDelete: "cascade" }),
  status: webhookDeliveryStatusEnum("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
