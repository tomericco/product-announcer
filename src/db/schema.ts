import { pgTable, pgEnum, uuid, text, timestamp, primaryKey, integer, jsonb, uniqueIndex, index, boolean, real } from "drizzle-orm/pg-core";

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

export const changeItemStatusEnum = pgEnum("change_item_status", ["pending", "batched", "excluded", "ignored"]);
export const cadenceEnum = pgEnum("cadence", ["daily", "weekly", "biweekly", "monthly", "none"]);
export const releaseStatusEnum = pgEnum("release_status", ["draft", "approved", "published", "rejected"]);
export const reviewStatusEnum = pgEnum("review_status", ["passed", "failed", "error"]);
export const updateCategoryEnum = pgEnum("update_category", ["new", "improvement", "fix", "announcement"]);

export const changeEventTypeEnum = pgEnum("change_event_type", ["commit", "pull_request", "task"]);
export const changeEventProviderEnum = pgEnum("change_event_provider", ["github", "notion"]);
export const notionConnectionStatusEnum = pgEnum("notion_connection_status", [
  "active",
  "needs_reauth",
  "misconfigured",
]);
export const atomicUpdateStatusEnum = pgEnum("atomic_update_status", ["open", "released", "hidden"]);
export const atomicUpdateSizeEnum = pgEnum("atomic_update_size", ["s", "m", "l", "xl"]);
// Why tier 1 dropped an event. Null means it was not dropped deterministically.
export const filterReasonEnum = pgEnum("filter_reason", [
  "merge_commit",
  "empty_diff",
  "lockfile_only",
  "test_only",
  "chore_prefix",
  "empty_task",
]);

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

export const changeEvents = pgTable(
  "change_events",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id").references(() => repos.id, { onDelete: "cascade" }),
    type: changeEventTypeEnum("type").notNull(),
    provider: changeEventProviderEnum("provider").notNull(),
    // Idempotency key, namespaced per provider. Commits use the SHA; PRs use
    // `owner/repo#number` because PR numbers collide across repos.
    externalId: text("external_id").notNull(),
    externalUrl: text("external_url"),
    atomicUpdateId: uuid("atomic_update_id").references(() => atomicUpdates.id, { onDelete: "set null" }),
    status: changeItemStatusEnum("status").notNull().default("pending"),
    // Why tier 1 dropped this event. Null means it survived the filter.
    filterReason: filterReasonEnum("filter_reason"),
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
    // When the commit reached the watched branch, as distinct from when it was
    // authored (`committedAt`) — a commit can be written days before it lands.
    // Only the push webhook knows this: GitHub's list-commits API carries no
    // branch-landing time, so backfilled/imported commits leave it null rather
    // than pretending the author date is a release.
    releasedAt: timestamp("released_at", { withTimezone: true }),
    // task-sourced fields (e.g. a completed Notion task)
    taskTitle: text("task_title"),
    taskDescription: text("task_description"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // tier 2 classifier output, null until classified
    userFacing: boolean("user_facing"),
    impactSummary: text("impact_summary"),
    suggestedCategory: updateCategoryEnum("suggested_category"),
    enrichmentConfidence: real("enrichment_confidence"),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("change_events_repo_pr_unique").on(table.repoId, table.prNumber),
    uniqueIndex("change_events_repo_commit_unique").on(table.repoId, table.commitSha),
    uniqueIndex("change_events_tenant_provider_external_unique").on(
      table.tenantId,
      table.provider,
      table.externalId
    ),
  ]
);

export const atomicUpdates = pgTable("atomic_updates", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  // Set when this atomic update joins a release draft. At most one release ever,
  // so "which release is this shipping in" always has a single answer.
  releaseId: uuid("release_id").references(() => releases.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  category: updateCategoryEnum("category"),
  size: atomicUpdateSizeEnum("size"),
  // Non-null freezes size against re-derivation — the size analogue of
  // summaryEditedAt. Set when a user manually picks a size on the card.
  sizeEditedAt: timestamp("size_edited_at", { withTimezone: true }),
  status: atomicUpdateStatusEnum("status").notNull().default("open"),
  // Non-null freezes regeneration: once a human edits the summary, attaching a
  // new change event must not overwrite their words.
  summaryEditedAt: timestamp("summary_edited_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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

export const releases = pgTable("releases", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  repoId: uuid("repo_id").references(() => repos.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  status: releaseStatusEnum("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  editedBy: uuid("edited_by").references(() => users.id),
  reviewStatus: reviewStatusEnum("review_status"),
  reviewIssues: jsonb("review_issues").$type<string[]>().notNull().default([]),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  // The baseline catch-up deltas measure against: how many new atomic updates
  // (or new commits on already-attached ones) have appeared since. Set at
  // claim, advanced again whenever a "catch up" merges the new material in.
  composedAt: timestamp("composed_at", { withTimezone: true }).notNull().defaultNow(),
  // Non-null means the body was hand-edited — the body's analogue of
  // atomicUpdates.summaryEditedAt. Lets the UI/merge know the body carries
  // hand edits worth preserving rather than silently overwriting.
  bodyEditedAt: timestamp("body_edited_at", { withTimezone: true }),
});

export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", ["pending", "success", "failed"]);

export const webhookConfigs = pgTable("webhook_configs", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  secretCiphertext: text("secret_ciphertext"),
  secretIv: text("secret_iv"),
  secretAuthTag: text("secret_auth_tag"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const destinationEnum = pgEnum("destination", ["webhook", "webflow"]);

export const deliveryAttempts = pgTable(
  "delivery_attempts",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    destination: destinationEnum("destination").notNull(),
    status: webhookDeliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    // Last error, surfaced in the UI. Null on success.
    lastError: text("last_error"),
    // Destination-side identifier, e.g. the Webflow CMS item id, so a
    // re-publish updates instead of duplicating.
    externalId: text("external_id"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per release+destination: dispatch reuses this row across
    // re-publishes, so a race between two concurrent publishes must not be
    // able to insert two rows for the same pair.
    uniqueIndex("delivery_attempts_release_id_destination_unique").on(table.releaseId, table.destination),
  ]
);

export const llmUsage = pgTable("llm_usage", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  // Plain text, not an enum: this list will grow, and Postgres has no DROP VALUE.
  operation: text("operation").notNull(),
  model: text("model").notNull(),
  // Nullable: the SDK types these as `number | undefined`, and a provider that
  // omits a count shouldn't cost us the row.
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  totalTokens: integer("total_tokens"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webflowAuthTypeEnum = pgEnum("webflow_auth_type", ["site_token", "oauth"]);
export const webflowPublishModeEnum = pgEnum("webflow_publish_mode", ["draft", "live"]);
export const webflowConnectionStatusEnum = pgEnum("webflow_connection_status", [
  "active",
  "needs_reauth",
  "misconfigured",
]);

// Keyed by Webflow field *slug*, not id, so renaming a field's display name in
// Webflow does not break the mapping.
export type WebflowFieldMapping = Record<
  string,
  | { source: "title" | "body" | "slug" | "publishedAt" | "empty" }
  | { source: "static"; value: string }
>;

export const webflowConnections = pgTable("webflow_connections", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: "cascade" }),
  authType: webflowAuthTypeEnum("auth_type").notNull().default("site_token"),
  tokenCiphertext: text("token_ciphertext").notNull(),
  tokenIv: text("token_iv").notNull(),
  tokenAuthTag: text("token_auth_tag").notNull(),
  // Null until the user completes the corresponding wizard step.
  siteId: text("site_id"),
  siteName: text("site_name"),
  collectionId: text("collection_id"),
  collectionName: text("collection_name"),
  fieldMapping: jsonb("field_mapping").$type<WebflowFieldMapping>().notNull().default({}),
  publishMode: webflowPublishModeEnum("publish_mode").notNull().default("draft"),
  status: webflowConnectionStatusEnum("status").notNull().default("active"),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const notionConnections = pgTable("notion_connections", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: "cascade" }),
  // OAuth access token (encrypted). Notion access tokens can expire when the
  // integration has token rotation enabled; a refresh token is then issued.
  accessTokenCiphertext: text("access_token_ciphertext").notNull(),
  accessTokenIv: text("access_token_iv").notNull(),
  accessTokenAuthTag: text("access_token_auth_tag").notNull(),
  // Refresh token (encrypted). Nullable: an integration without token rotation
  // issues no refresh token, and a 401 on such a connection can only flip it to
  // needs_reauth (there is nothing to refresh with).
  refreshTokenCiphertext: text("refresh_token_ciphertext"),
  refreshTokenIv: text("refresh_token_iv"),
  refreshTokenAuthTag: text("refresh_token_auth_tag"),
  // The routing key for inbound webhooks (payload.workspace_id). Indexed.
  workspaceId: text("workspace_id").notNull(),
  botId: text("bot_id"),
  // Null until the tenant completes the corresponding wizard step.
  databaseId: text("database_id"),
  databaseName: text("database_name"),
  statusPropertyId: text("status_property_id"),
  statusPropertyName: text("status_property_name"),
  // Which values of the status property mean "done". Empty until step 3.
  doneValues: text("done_values").array().notNull().default([]),
  status: notionConnectionStatusEnum("status").notNull().default("misconfigured"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("notion_connections_workspace_idx").on(table.workspaceId),
]);

export type NotionConnection = typeof notionConnections.$inferSelect;
