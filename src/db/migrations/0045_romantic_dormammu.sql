CREATE TABLE "system_content_examples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"industry" text,
	"persona_key" text,
	"content_type" "content_type" DEFAULT 'product_update' NOT NULL,
	"category" "update_category",
	"title" text NOT NULL,
	"body" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_content_examples_key_unique" UNIQUE("key")
);
--> statement-breakpoint
-- Carries the system_update_examples seed forward (see 0011_dear_legion.sql)
-- into the renamed/extended table before that table is dropped in the next
-- migration. Every row is changelog-shaped, so content_type is explicitly
-- product_update; category keeps its original value (current enum labels).
INSERT INTO "system_content_examples" ("id", "key", "industry", "persona_key", "content_type", "category", "title", "body", "sort_order") VALUES
	(gen_random_uuid(), 'saas-pm-new', 'SaaS', 'product-manager', 'product_update', 'new', $$Dashboards you can share with your whole team$$, $$You can now create shared dashboards and invite teammates to view them in real time.

- Build a dashboard once and share it with a link
- Control who can view or edit
- See changes update live as data comes in

Great for keeping stakeholders aligned without exporting screenshots.$$, 10),
	(gen_random_uuid(), 'saas-marketing-improved', 'SaaS', 'marketing-manager', 'product_update', 'improvement', $$Faster, cleaner reports that are ready to present$$, $$We rebuilt reporting from the ground up. Reports now load in under a second and export to a polished PDF in one click.

Whether you're sharing results with a client or your leadership team, your numbers look sharp and load instantly.$$, 20),
	(gen_random_uuid(), 'saas-support-fixed', 'SaaS', 'support-lead', 'product_update', 'fix', $$Fixed: invitation emails landing in spam$$, $$Some invitation emails were being flagged as spam and never reached new users. We've updated our sending setup so invitations now arrive reliably in the inbox.

If a teammate reported a missing invite, ask them to resend it — it should arrive within a minute.$$, 30),
	(gen_random_uuid(), 'devtools-developer-new', 'Developer Tools', 'developer', 'product_update', 'new', $$Ship webhooks with the new Events API$$, $$The new Events API lets you subscribe to changes and receive signed webhook deliveries.

- `POST /v1/webhooks` to register an endpoint
- Verify payloads with the `X-Signature` header and your signing secret
- Automatic retries with exponential backoff for failed deliveries

See the Events reference for the full list of event types.$$, 40),
	(gen_random_uuid(), 'devtools-developer-improved', 'Developer Tools', 'developer', 'product_update', 'improvement', $$Pagination is now cursor-based across every list endpoint$$, $$List endpoints now return a stable `next_cursor` instead of offset paging, so results no longer shift when records are added mid-scan.

- Pass `?cursor=<next_cursor>` to fetch the next page
- Offset params still work but are deprecated and will be removed in v2

Update your SDK to `>=3.2.0` to pick this up automatically.$$, 50),
	(gen_random_uuid(), 'devtools-developer-fixed', 'Developer Tools', 'developer', 'product_update', 'fix', $$Fixed: rate-limit headers missing on 429 responses$$, $$`429 Too Many Requests` responses were omitting the `Retry-After` and `X-RateLimit-Reset` headers, making backoff hard to implement. Both headers are now returned on every throttled response.

No action needed — your existing retry logic will start seeing accurate reset times immediately.$$, 60),
	(gen_random_uuid(), 'fintech-pm-new', 'Fintech', 'product-manager', 'product_update', 'new', $$Set spending limits per card$$, $$Admins can now set daily and monthly spending limits on individual cards.

- Configure limits from the card's settings
- Limits apply instantly, no reissue needed
- Get notified when a card approaches its limit

A frequently requested control for teams managing employee spend.$$, 70),
	(gen_random_uuid(), 'fintech-support-fixed', 'Fintech', 'support-lead', 'product_update', 'fix', $$Fixed: pending transactions showing the wrong balance$$, $$Pending transactions were briefly double-counted, causing available balances to look lower than they actually were. Balances now reflect pending activity correctly.

No customer action is needed — affected balances corrected themselves automatically. This did not affect any actual charges.$$, 80),
	(gen_random_uuid(), 'fintech-marketing-improved', 'Fintech', 'marketing-manager', 'product_update', 'improvement', $$Instant transfers, now free on every plan$$, $$Instant transfers used to carry a small fee — now they're free for everyone, on every plan.

Move money between accounts in seconds, at no extra cost. It's a simpler, more competitive experience for your customers.$$, 90),
	(gen_random_uuid(), 'ecommerce-marketing-new', 'E-commerce', 'marketing-manager', 'product_update', 'new', $$Launch storewide sales with scheduled discounts$$, $$Plan your next promotion in advance with scheduled discounts.

- Set a start and end time — discounts go live and expire automatically
- Apply to your whole store, a collection, or specific products
- Preview the sale banner before it launches

Perfect for Black Friday, flash sales, and seasonal campaigns.$$, 100),
	(gen_random_uuid(), 'ecommerce-pm-improved', 'E-commerce', 'product-manager', 'product_update', 'improvement', $$A faster, one-page checkout$$, $$We collapsed checkout into a single page, cutting the steps from four to one.

Early testing shows a meaningful lift in completed purchases, especially on mobile. Returning customers see their saved details prefilled for an even quicker checkout.$$, 110),
	(gen_random_uuid(), 'ecommerce-support-fixed', 'E-commerce', 'support-lead', 'product_update', 'fix', $$Fixed: order confirmation emails delayed by several hours$$, $$Order confirmation emails were sometimes delayed by up to a few hours, prompting customers to ask whether their order went through. Confirmations now send within seconds of purchase.

If a customer contacts you about a missing confirmation, they can resend it from their order history page.$$, 120),
	(gen_random_uuid(), 'healthcare-pm-new', 'Healthcare', 'product-manager', 'product_update', 'new', $$Book appointments online, 24/7$$, $$Patients can now book, reschedule, and cancel appointments online at any time.

- See real-time availability by provider
- Automatic reminders reduce no-shows
- Syncs directly with your existing calendar

Less phone tag for your front desk, more convenience for patients.$$, 130),
	(gen_random_uuid(), 'healthcare-support-improved', 'Healthcare', 'support-lead', 'product_update', 'improvement', $$Clearer messages when a document fails to upload$$, $$When a patient document failed to upload, the old error was vague and generated support tickets. Uploads now explain exactly what went wrong — file too large, unsupported format, or a connection issue — and how to fix it.

Expect fewer "my upload isn't working" questions.$$, 140)
ON CONFLICT ("key") DO NOTHING;
