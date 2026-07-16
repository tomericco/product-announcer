CREATE TABLE "system_personas" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"brief" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_personas_key_unique" UNIQUE("key")
);
--> statement-breakpoint
INSERT INTO "system_personas" ("id", "key", "name", "description", "brief", "sort_order") VALUES
	(gen_random_uuid(), 'developer', 'Developer', 'Engineers who build with or integrate your product', 'Cares about the technical substance of a change: new or changed APIs, SDKs, config, breaking changes, migrations, performance, and reliability. Wants precise specifics such as endpoints, flags, and versions, plus code-level implications. Emphasize exactly what they must do to adopt it. Avoid leading with marketing language or vague benefits.', 10),
	(gen_random_uuid(), 'ux-designer', 'UX Designer', 'Designers focused on flows, usability, and visual polish', 'Cares about changes to flows, layouts, components, interaction patterns, and visual details. Wants to know what the experience looks and feels like now and how it affects existing designs. Emphasize before-and-after behavior and design-system impact. Avoid overloading with backend or infrastructure detail.', 20),
	(gen_random_uuid(), 'product-manager', 'Product Manager', 'PMs tracking scope, outcomes, and roadmap impact', 'Cares about user outcomes, scope, and how a change moves metrics or the roadmap. Wants the why and the impact on customers and adjacent features. Emphasize the value delivered, affected segments, and follow-on opportunities. Avoid dwelling on low-level implementation.', 30),
	(gen_random_uuid(), 'ux-writer', 'UX Writer', 'Writers who own product copy, terminology, and tone', 'Cares about anything touching product copy, labels, terminology, empty states, and tone. Wants to know where wording changed or is newly needed, and any concepts to name consistently. Emphasize naming, microcopy, and terminology consistency. Avoid focusing on architecture or performance.', 40),
	(gen_random_uuid(), 'localization-manager', 'Localization Manager', 'Owners of translation, locale coverage, and cultural fit', 'Cares about new or changed user-facing strings, locale coverage, date and number formats, and text that may not fit or translate cleanly. Wants a heads-up on what needs translation and any cultural or layout risks. Emphasize string changes and locale impact. Avoid engineering internals.', 50),
	(gen_random_uuid(), 'marketing-manager', 'Marketing Manager', 'Marketers turning changes into launches and messaging', 'Cares about changes worth announcing to customers and prospects: headline value, differentiation, and launch-worthiness. Wants a crisp, benefit-led framing and the customer-facing story. Emphasize what is new and why it matters. Avoid burying it in technical caveats.', 60),
	(gen_random_uuid(), 'support-lead', 'Customer Support Lead', 'Leads who prep teams and docs for what customers will ask', 'Cares about what customers will notice, ask about, or hit problems with. Wants to know behavior changes, known issues, workarounds, and anything needing doc or macro updates. Emphasize customer-visible effects and support implications. Avoid focusing on internal architecture.', 70),
	(gen_random_uuid(), 'qa-engineer', 'QA Engineer', 'Testers focused on correctness, regressions, and edge cases', 'Cares about correctness, regressions, edge cases, and what changed enough to warrant retesting. Wants specifics on affected areas, new states, and risk. Emphasize testable behavior changes and boundaries. Avoid leading with marketing benefits.', 80)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
UPDATE "brand_profiles" SET "user_personas" = '[]'::jsonb;
