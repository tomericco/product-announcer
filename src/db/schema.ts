import { pgTable, pgEnum, uuid, text, timestamp, primaryKey, integer, smallint, jsonb, uniqueIndex, index, boolean, real } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
  // Furthest wizard step reached (1–4). An explicit column because steps 2 and 3
  // are skippable — their DB artifacts cannot distinguish "skipped" from "not
  // reached" — and `name` is auto-derived at signup, so it is never empty.
  onboardingStep: integer("onboarding_step").notNull().default(1),
  // Which day the /calendar month grid starts on: 0 = Sunday, 1 = Monday.
  // Defaults to 0 because that is what the grid hardcoded before this column
  // existed — every workspace that predates it keeps exactly today's layout.
  weekStartsOn: smallint("week_starts_on").notNull().default(0),
  // ISO 3166-1 alpha-2 codes whose PUBLIC holidays the calendar labels.
  // Empty by default: no workspace gets holidays it did not ask for. The
  // holidays themselves are never stored — they are recomputed per request
  // from date-holidays' rules (see src/lib/content/holidays.ts), which is the
  // whole reason a rule-based source was chosen over a baked-in list.
  holidayCountries: text("holiday_countries").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  name: text("name"),
  githubId: text("github_id").unique(),
  googleId: text("google_id").unique(),
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

export const tenantInvites = pgTable(
  "tenant_invites",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // SHA-256 hex of the raw token. The raw token is never persisted.
    tokenHash: text("token_hash").notNull().unique(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // At most one *active* (non-revoked) invite per tenant. Also makes concurrent
    // "regenerate" safe: two simultaneous active inserts → one wins, the other retries.
    uniqueIndex("tenant_invites_one_active_per_tenant")
      .on(table.tenantId)
      .where(sql`${table.revokedAt} IS NULL`),
  ]
);

export const changeItemStatusEnum = pgEnum("change_item_status", ["pending", "batched", "excluded", "ignored"]);
export const reviewStatusEnum = pgEnum("review_status", ["passed", "failed", "error"]);
export const updateCategoryEnum = pgEnum("update_category", ["new", "improvement", "fix", "announcement"]);
export const contentTypeEnum = pgEnum("content_type", ["product_update", "blog_post", "social_post"]);
export const contentPieceStatusEnum = pgEnum("content_piece_status", [
  "brief",
  "draft",
  "review",
  "scheduled",
  "published",
  "archived",
]);

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

export const rejectedArticleReasonEnum = pgEnum("rejected_article_reason", ["not_selected", "stale"]);

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
  // Set when this atomic update joins a content piece. At most one ever, so
  // "which piece is this shipping in" always has a single answer.
  contentPieceId: uuid("content_piece_id").references(() => contentPieces.id, { onDelete: "set null" }),
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
  // Time-of-day (0-23, UTC) the ideation agent runs for this tenant. `vercel.ts`
  // pins the cron to a single daily fixed-time invocation (Hobby plan limit),
  // so a per-tenant hour cannot literally be honoured by the current
  // infrastructure — spec 5 will need either a different cron plan or to treat
  // this as a "preferred window" rather than an exact trigger time.
  hour: integer("hour").notNull().default(9),
  // No reader and no writer today — both save paths write only `hour`.
  // Retained deliberately: spec 5's ideation run uses these.
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  nextScheduledAt: timestamp("next_scheduled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const companyProfiles = pgTable("company_profiles", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: "cascade" }),
  // The company's own site. The onboarding bootstrap agent (spec 2) reads it to
  // draft everything below; the human then corrects it.
  websiteUrl: text("website_url"),
  oneLiner: text("one_liner"),
  // The company's market category (e.g. "Project management software").
  // Written by the onboarding bootstrap agent (spec 2) and hand-correctable
  // in Company settings; intended as relevance context for spec 3's source
  // agents, which don't exist yet. Distinct from `industry` below, which
  // selects writing exemplars rather than describing the market.
  category: text("category"),
  // Differentiators and the messages the company wants to own. Not a setting —
  // this is the yardstick every incoming signal is scored for relevance against.
  positioning: text("positioning"),
  // The subjects in the company's lane. Drives the news agent's search (spec 4).
  topics: text("topics").array().notNull().default([]),
  // The team's company-wide content guidelines, as Markdown. Null until they
  // save for the first time — the editor shows a starter template instead, and
  // the prompt builders omit the guidelines block entirely while it is null.
  guidelines: text("guidelines"),
  // Live and load-bearing, unlike `category` above: `selectExamples` matches
  // few-shot exemplars on this, and `brand-import.ts` writes it from the
  // scraped page.
  industry: text("industry"),
  updatesPageUrl: text("updates_page_url"),
  userPersonas: jsonb("user_personas").$type<PersonaRef[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const competitors = pgTable(
  "competitors",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // The competitor's home page. The specific pages we watch — changelog, blog,
    // releases — are `sources` rows in spec 3, so one competitor can have several.
    websiteUrl: text("website_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The bootstrap proposes competitors and a human adds more by hand; without
    // this a re-run would silently duplicate every name it proposed before.
    uniqueIndex("competitors_tenant_name_unique").on(table.tenantId, table.name),
  ]
);

export type Competitor = typeof competitors.$inferSelect;

export const signalKindEnum = pgEnum("signal_kind", ["shipped_work", "competitor_move", "market_news", "manual"]);
export const signalStatusEnum = pgEnum("signal_status", ["new", "used", "stale"]);
export const sourceTypeEnum = pgEnum("source_type", ["competitor_web", "news"]);
export const sourceStatusEnum = pgEnum("source_status", ["active", "failing", "disabled"]);

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    type: sourceTypeEnum("type").notNull(),
    // Set for competitor_web sources. One competitor can have several sources —
    // a changelog and a blog are watched separately because they publish at
    // different rhythms and carry different signal.
    competitorId: uuid("competitor_id").references(() => competitors.id, { onDelete: "cascade" }),
    // The page we poll. Null for topic-driven news sources (spec 4), which
    // search rather than fetch a fixed URL.
    url: text("url"),
    // The agent-facing representation of `url` when the competitor publishes
    // one — a `.md` variant, or the site's llms.txt. Preferred at fetch time
    // because those pages are written for machines: no nav, no cookie banner,
    // no marketing chrome, so both block extraction and relevance scoring get
    // cleaner input. Resolved once at discovery rather than probed every run;
    // re-running discovery is what picks up a competitor who adds one later.
    agentUrl: text("agent_url"),
    label: text("label").notNull(),
    // Per-source cursor. For competitor_web sources (competitor-agent.ts):
    // `{ seenHashes: string[] }`, the block hashes confirmed present as of the
    // last run, in last-seen order (oldest-still-present first, capped at
    // MAX_WATERMARK_HASHES) — there are no feeds and therefore no entry ids
    // or dates to track, only "was this block here before." jsonb rather than
    // columns because shape is expected to vary by source type.
    // News sources (news-agent.ts) deliberately leave this empty: an article
    // has its own durable identity (its URL) and its own date, so dedupe is
    // the `signals_tenant_kind_external_unique` index rather than a cursor.
    // Nothing here needs to be remembered between runs.
    watermark: jsonb("watermark").$type<Record<string, unknown>>().notNull().default({}),
    // Sources rot: sites redesign, feeds move. Surfaced in settings the way the
    // Notion and Webflow connection statuses already are, rather than failing
    // silently for weeks.
    status: sourceStatusEnum("status").notNull().default("active"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per watched (non-null) URL per tenant, so re-running discovery
    // tops up instead of duplicating. Partial (`url IS NOT NULL`): Postgres
    // treats NULLs as distinct from one another, so this gives no uniqueness
    // to null-url sources — topic-driven news sources are the null-url case
    // *by design*. Their idempotency comes from the tenant+type index nine
    // lines below, not from this one.
    uniqueIndex("sources_tenant_url_unique")
      .on(table.tenantId, table.url)
      .where(sql`${table.url} IS NOT NULL`),
    // The mirror of the index above, for the null-url half of the table.
    // Postgres treats NULLs as distinct from one another, so the partial
    // unique index above gives null-url rows no uniqueness whatsoever — a
    // tenant could accumulate unlimited identical news sources. A topic-driven
    // news source has no URL to be identified by; its identity is simply
    // "this tenant's news source", so that is what this enforces.
    uniqueIndex("sources_tenant_type_null_url_unique")
      .on(table.tenantId, table.type)
      .where(sql`${table.url} IS NULL`),
  ]
);

export type Source = typeof sources.$inferSelect;

export const signals = pgTable(
  "signals",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sourceId: uuid("source_id").references(() => sources.id, { onDelete: "set null" }),
    kind: signalKindEnum("kind").notNull(),
    // Idempotency key, namespaced per kind. Shipped work uses the atomic
    // update's id; feed entries use their guid; news uses the article URL.
    // `syncShippedWorkSignals` withdraws/stale-marks shipped_work signals with
    // an unscoped, cross-tenant query — safe only because the atomic update's
    // UUID is globally unique, unlike a feed guid or article URL, which this
    // column anticipates being shared across tenants for other kinds. A future
    // producer that writes `shipped_work` rows with a non-UUID externalId
    // would silently break that cross-tenant safety.
    externalId: text("external_id").notNull(),
    url: text("url"),
    title: text("title").notNull(),
    excerpt: text("excerpt"),
    // When the thing happened, as distinct from when we noticed it. Ranking in
    // spec 5 decays on this, so a backfilled old post must not read as fresh.
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    // Set on shipped_work signals. ON DELETE SET NULL rather than cascade: the
    // signal is the durable record of what happened, and losing the atomic
    // update should not erase the evidence a published piece was built from.
    atomicUpdateId: uuid("atomic_update_id").references(() => atomicUpdates.id, { onDelete: "set null" }),
    competitorId: uuid("competitor_id").references(() => competitors.id, { onDelete: "set null" }),
    // Null means scoring failed, not "scored zero" — the rationale says which.
    // On competitor_move signals a failed classifier writes the signal anyway:
    // a missed competitor move is invisible, an unscored row in the browser
    // announces itself. market_news does NOT work that way — its selection pass
    // fails closed, so a failed judgement writes no row at all and the source is
    // marked failing instead.
    relevanceScore: real("relevance_score"),
    relevanceRationale: text("relevance_rationale"),
    topics: text("topics").array().notNull().default([]),
    // `used` is a reporting and pruning flag, NOT a consumption gate: spec 5's
    // ideation happily re-reads a signal it cited last week, because that
    // signal can join a new cluster this week.
    // `stale` IS a gate, and deliberately so. Ideation omits `includeStale`, so
    // `listSignals` filters stale rows out: a stale `shipped_work` signal is
    // work that was withdrawn, and commissioning a brief about something that
    // no longer ships is worse than saying nothing.
    status: signalStatusEnum("status").notNull().default("new"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("signals_tenant_kind_external_unique").on(table.tenantId, table.kind, table.externalId),
    index("signals_tenant_occurred_idx").on(table.tenantId, table.occurredAt),
    index("signals_tenant_kind_occurred_idx").on(table.tenantId, table.kind, table.occurredAt),
    // Every read (the browser, the eventual purge) unconditionally filters on
    // (tenantId, createdAt) for the 60-day window — the two existing indexes
    // above lead with occurredAt, which doesn't serve that predicate. Nothing
    // prunes the table yet, so without this a tenant's full history is
    // scanned to find the recent slice.
    index("signals_tenant_created_idx").on(table.tenantId, table.createdAt),
  ]
);

export type Signal = typeof signals.$inferSelect;

export const briefOriginEnum = pgEnum("brief_origin", ["agent", "manual"]);
export const briefStatusEnum = pgEnum("brief_status", ["new", "accepted", "dismissed", "expired"]);
export const briefDismissReasonEnum = pgEnum("brief_dismiss_reason", [
  "off_topic",
  "wrong_angle",
  "already_covered",
  "not_our_voice",
  "other",
]);

export const briefs = pgTable(
  "briefs",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    origin: briefOriginEnum("origin").notNull(),
    // Null for agent-proposed briefs. Set when a human creates one by hand
    // (the manual-creation spec).
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    contentType: contentTypeEnum("content_type").notNull(),
    title: text("title").notNull(),
    angle: text("angle").notNull(),
    whyNow: text("why_now").notNull(),
    // Text, not an enum: destinations will grow and Postgres has no DROP VALUE.
    suggestedChannel: text("suggested_channel").notNull(),
    audience: text("audience"),
    // 3-5 entries, one sentence each. The cap is enforced in the ideation
    // schema (zod) rather than here — a brief is a commission, not a first
    // draft, and the spike measured 6.5 points averaging 27 words when
    // uncapped. There is deliberately no `outline` column: ordered key points
    // ARE the outline, and keeping both guarantees they drift apart the first
    // time a human edits one.
    keyPoints: text("key_points").array().notNull().default([]),
    targetLength: integer("target_length"),
    // The model's own recommendation strength. The spike found these cluster
    // narrowly (0.66-0.92), so this ranks poorly on its own once a backlog
    // exists — the inbox orders by score AND recency, and see the accepted
    // gaps at the bottom of this plan.
    score: real("score").notNull(),
    scoreRationale: text("score_rationale"),
    status: briefStatusEnum("status").notNull().default("new"),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    // The accepted brief's content piece. SET NULL rather than cascade: the
    // brief is the durable record that a human accepted something, and deleting
    // the draft must not erase that decision.
    //
    // Uniqueness is already enforced by `briefs_content_piece_unique` below —
    // do NOT add another index.
    contentPieceId: uuid("content_piece_id").references(() => contentPieces.id, {
      onDelete: "set null",
    }),
    dismissReason: briefDismissReasonEnum("dismiss_reason"),
    dismissNote: text("dismiss_note"),
    dismissedBy: uuid("dismissed_by").references(() => users.id, { onDelete: "set null" }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    // Follows the existing summaryEditedAt/bodyEditedAt convention: a human
    // edit freezes regeneration.
    editedAt: timestamp("edited_at", { withTimezone: true }),
    // The brief as a markdown document. Null on briefs created before this
    // existed, and on those `briefBody()` renders the same markdown from the
    // structured fields on demand — the fallback IS the renderer, so there is
    // no second code path and no backfill to get wrong. The first save writes a
    // real body and the fallback stops applying to that row.
    //
    // Source of truth once set: the structured fields are NEVER re-derived from
    // it. There is no markdown-to-fields parse anywhere and there must not be.
    body: text("body"),
    // Bumped whenever a later run attaches fresh evidence, so a brief that
    // keeps gathering support stays near the top instead of ageing out. The
    // ageing-out half is `expiresAt`'s doing, not this column's: the extend
    // path in `briefs/run.ts` moves both, because expiry filters on
    // `expiresAt` alone and bumping only this one would leave the promise
    // above a lie.
    lastEvidenceAt: timestamp("last_evidence_at", { withTimezone: true }).notNull(),
    // Null means this brief never expires. Agent briefs always carry a date —
    // the inbox would otherwise accumulate undecided proposals forever — but a
    // brief a human wrote by hand is a deliberate act, and deleting it on a
    // timer is not ours to do. A far-future date was the alternative and would
    // have been a value the data claims and the sweep never honours.
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("briefs_tenant_status_score_idx").on(table.tenantId, table.status, table.score),
    index("briefs_tenant_status_expires_idx").on(table.tenantId, table.status, table.expiresAt),
    // Two briefs must never claim the same piece. Partial because
    // contentPieceId is null for everything that has not been accepted, and
    // Postgres treats NULLs as distinct from one another.
    uniqueIndex("briefs_content_piece_unique")
      .on(table.contentPieceId)
      .where(sql`${table.contentPieceId} IS NOT NULL`),
  ]
);

export type Brief = typeof briefs.$inferSelect;

export const briefSignals = pgTable(
  "brief_signals",
  {
    briefId: uuid("brief_id")
      .notNull()
      .references(() => briefs.id, { onDelete: "cascade" }),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    // Null when the agent attached it; set when a human did.
    addedBy: uuid("added_by").references(() => users.id, { onDelete: "set null" }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.briefId, table.signalId] }),
    // Postgres indexes the PK, which leads with briefId — it does NOT index
    // the referencing side of the signalId FK. Without this, every signal
    // delete scans this table to enforce the cascade, and the accepted-brief
    // exemption that `signals/window.ts` instructs a future author to build is
    // exactly a `signal_id →` lookup.
    index("brief_signals_signal_idx").on(table.signalId),
  ]
);

export type BriefSignal = typeof briefSignals.$inferSelect;

// Global, seeded catalog of built-in personas. Tenants reference these by `key`
// from their company profile; the brief steers how updates are written for them.
export const systemPersonas = pgTable("system_personas", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  brief: text("brief").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Global, seeded catalog of example content pieces. Selected at generation time
// by industry/persona match (and content type) and injected into the prompt as
// few-shot exemplars.
export const systemContentExamples = pgTable("system_content_examples", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  key: text("key").notNull().unique(),
  industry: text("industry"),
  personaKey: text("persona_key"),
  // Which kind of content this exemplar demonstrates. Few-shot selection filters
  // on it, so a blog prompt never sees changelog exemplars.
  contentType: contentTypeEnum("content_type").notNull().default("product_update"),
  // Meaningful only for product updates; null for blog and social exemplars.
  category: updateCategoryEnum("category"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contentPieces = pgTable("content_pieces", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" }),
  repoId: uuid("repo_id").references(() => repos.id, { onDelete: "cascade" }),
  // Which kind of content this is. Drives the draft prompt and the channels it
  // can publish to. Defaults to product_update because that is the only type the
  // generation pipeline can produce until spec 9 adds the others.
  type: contentTypeEnum("type").notNull().default("product_update"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  // "brief" means approved-but-not-yet-drafted, so a lead can approve several
  // briefs at once and generate drafts across the week.
  status: contentPieceStatusEnum("status").notNull().default("draft"),
  // When this is due to go out. Null until scheduled; the calendar renders this.
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  assignedTo: uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  editedBy: uuid("edited_by").references(() => users.id),
  publishedBy: uuid("published_by").references(() => users.id),
  reviewStatus: reviewStatusEnum("review_status"),
  reviewIssues: jsonb("review_issues").$type<string[]>().notNull().default([]),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  // Why the last generation attempt did not produce a usable draft. Carries two
  // distinct meanings, and the status disambiguates them:
  //   status "brief" + set  -> generation failed; the scaffold body is intact
  //                            and the Generate button offers a retry.
  //   status "draft" + set  -> the draft is real, but the post-generation name
  //                            scan matched something the copy should not name.
  // Null on a clean generated draft. A third meaning would need its own column
  // rather than a third overload of this one.
  generationError: text("generation_error"),
  // When a model last wrote this body. Null means the body is still the
  // deterministic scaffold written at accept time. Distinct from
  // `bodyEditedAt`, which records a HUMAN edit and freezes regeneration.
  generatedAt: timestamp("generated_at", { withTimezone: true }),
  // The DraftStepKey currently in flight (see lib/drafting/draft-progress.ts),
  // or null when nothing is generating. Persisted rather than streamed because
  // generation runs in `after()`, which has no open response to stream into —
  // the client polls this instead.
  //
  // Free text, not an enum: the step vocabulary lives in TypeScript, a piece
  // generated before this column existed reads null and renders as "no progress
  // information", and adding a step later must not need a migration.
  //
  // MUST be cleared in every terminal write — success, failure, and the
  // interrupted-generation marker. A piece left displaying a step it is no
  // longer running is worse than showing none.
  generationStep: text("generation_step"),
  // The baseline catch-up deltas measure against: how many new atomic updates
  // (or new commits on already-attached ones) have appeared since. Set at
  // claim, advanced again whenever a "catch up" merges the new material in.
  composedAt: timestamp("composed_at", { withTimezone: true }).notNull().defaultNow(),
  // Non-null means the body was hand-edited — lets the merge preserve hand
  // edits rather than silently overwriting them.
  bodyEditedAt: timestamp("body_edited_at", { withTimezone: true }),
});

export const channelVariants = pgTable(
  "channel_variants",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    contentPieceId: uuid("content_piece_id")
      .notNull()
      .references(() => contentPieces.id, { onDelete: "cascade" }),
    // Plain text, not an enum: the destination list will grow and Postgres has
    // no DROP VALUE. Values match `destinationEnum` where they overlap.
    channel: text("channel").notNull(),
    body: text("body").notNull(),
    // Non-null marks a hand-edit, so regeneration can warn before overwriting.
    editedAt: timestamp("edited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One body per piece per channel — two rows would make "what do we post to
    // LinkedIn" ambiguous at delivery time.
    uniqueIndex("channel_variants_piece_channel_unique").on(table.contentPieceId, table.channel),
  ]
);

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

export const destinationEnum = pgEnum("destination", ["webhook", "webflow", "linkedin"]);

export const deliveryAttempts = pgTable(
  "delivery_attempts",
  {
    id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    contentPieceId: uuid("content_piece_id")
      .notNull()
      .references(() => contentPieces.id, { onDelete: "cascade" }),
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
    // One row per content piece+destination: dispatch reuses this row across
    // re-publishes, so a race between two concurrent publishes must not be
    // able to insert two rows for the same pair.
    uniqueIndex("delivery_attempts_content_piece_destination_unique").on(
      table.contentPieceId,
      table.destination
    ),
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

export const linkedinConnectionStatusEnum = pgEnum("linkedin_connection_status", [
  "active",
  "needs_reauth",
  "misconfigured",
]);

export const linkedinConnections = pgTable("linkedin_connections", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id, { onDelete: "cascade" }),
  accessTokenCiphertext: text("access_token_ciphertext").notNull(),
  accessTokenIv: text("access_token_iv").notNull(),
  accessTokenAuthTag: text("access_token_auth_tag").notNull(),
  // Null until the first token exchange returns a refresh token (requires the
  // app to be approved for refresh tokens).
  refreshTokenCiphertext: text("refresh_token_ciphertext"),
  refreshTokenIv: text("refresh_token_iv"),
  refreshTokenAuthTag: text("refresh_token_auth_tag"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // Null until the user selects an administered organization.
  organizationUrn: text("organization_urn"),
  organizationName: text("organization_name"),
  // Tenant changelog/release base URL for link-backs. Null until set.
  baseUrl: text("base_url"),
  // Optional company-specific LinkedIn writing guidelines that extend the copy
  // generation prompt (tone, do/don't, hashtags, etc.). Null/empty = none.
  postGuidelines: text("post_guidelines"),
  status: linkedinConnectionStatusEnum("status").notNull().default("active"),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Articles the news agent has already judged and will not reconsider.
 *
 * Deliberately NOT a status on `signals`. A rejected article is not a signal,
 * and putting it there would make every reader — `listSignals`, the signals
 * browser, `runIdeation` — responsible for excluding it. A miss in any one of
 * them puts junk in front of the brief agent. A separate table cannot leak.
 *
 * Written for two different reasons, distinguished by `reason`: the selector
 * turned it down (`not_selected`), or the article's own page dated it outside
 * RECENCY_WINDOW_DAYS (`stale`). Both are permanent — re-judging reaches the
 * same answer, and at ~15 rejections per tenant per day this table grows by
 * roughly 5k rows a year.
 *
 * `url` is stored NORMALIZED, via `normalizeArticleUrl`. That makes this the
 * second persisted consumer of that function alongside `signals.externalId`,
 * so it is doubly a data contract: changing normalization makes both the skip
 * query and this one miss, and re-admits every already-handled article.
 *
 * A rejection survives a company-profile edit. An article turned down under
 * old topics is not reconsidered under new ones — accepted deliberately,
 * because clearing on every edit re-opens the re-fetch flood this table exists
 * to close.
 */
export const rejectedArticles = pgTable(
  "rejected_articles",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    // Already in hand when the rejection is recorded. Without it the table is
    // a list of opaque URLs and nobody can tell a bad article from an old one.
    title: text("title").notNull(),
    reason: rejectedArticleReasonEnum("reason").notNull(),
    // No expiry is enforced. Stored so a purge can be added later without a
    // migration — NOT read by any query today.
    rejectedAt: timestamp("rejected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Tenant-scoped: the same article rejected by two tenants is two rows.
    // Keying on url alone would let one tenant's judgement hide an article
    // from every other tenant.
    uniqueIndex("rejected_articles_tenant_url_unique").on(table.tenantId, table.url),
  ]
);

/**
 * One row per ideation run, whatever the outcome. Written by every run, read
 * by nothing.
 *
 * Exists because of the failure this codebase already named in
 * `src/lib/briefs/run.ts` — a permanently broken ideation is
 * "indistinguishable from a genuinely quiet company: the cron reports ok, no
 * brief appears, and nothing is written anywhere." This table is the
 * "anywhere": these rows are the only record that a run happened at all, and
 * the only place an ideation error gets captured (`error` below) rather than
 * just logged to console and lost. When the agent is misbehaving, this is
 * where a developer looks — query it directly.
 *
 * Nothing in the product reads it. The inbox page that once did — so an empty
 * inbox could say which of "never run" / "ran, found nothing" / "ran and
 * failed" it was looking at — is gone; briefs now live in the board's Brief
 * column, and an empty column can't tell those three apart. That's a
 * deliberate, owner-approved loss, not an oversight: run status was decided
 * not worth surfacing anywhere in the UI. This table is left write-only on
 * purpose, as the fallback for whoever next needs to debug a quiet agent.
 *
 * The assessment lives HERE and not on `briefs` on purpose: it describes a
 * run, not a brief, and denormalising it onto each brief would mean a run that
 * produced zero briefs carries no assessment at all — precisely the case worth
 * explaining.
 *
 * No retention is enforced. At one row per tenant per day this is ~365 rows a
 * year; `ranAt` is stored so a purge can be added later without a migration.
 */
export const briefRuns = pgTable(
  "brief_runs",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
    // The model's one-line judgement of the period. Null when the call failed —
    // there is no judgement to record, and a placeholder string would read as one.
    assessment: text("assessment"),
    briefsCreated: integer("briefs_created").notNull().default(0),
    briefsExtended: integer("briefs_extended").notNull().default(0),
    // Null on a clean run. Carries the ideation error, which `runIdeation`
    // otherwise only writes to console.
    error: text("error"),
  },
  (table) => [
    // Nothing in the product queries this table (see the table comment), but
    // a developer debugging a quiet agent will still want this tenant's most
    // recent rows fast.
    index("brief_runs_tenant_ran_at_idx").on(table.tenantId, table.ranAt),
  ]
);

export type BriefRun = typeof briefRuns.$inferSelect;
