# Multi-User Workspaces, Invite Links & Google Auth — Design

**Date:** 2026-07-26
**Status:** Approved (pending implementation plan)

## 1. Goal & scope

Turn the app from effectively single-user-per-workspace into a standard multi-user SaaS:

1. **Multi-user workspaces** — a user can belong to one or more workspaces, sees only workspaces they're a member of, and can view the other members of their current workspace.
2. **Invite links** — an owner generates a shareable, unguessable, expiring invite link from workspace settings; a recipient opens it, authenticates, and joins the workspace.
3. **Google auth** — Google OAuth alongside GitHub, provider-agnostic, matching existing users by verified email instead of creating duplicates.
4. **UX** — a branded sign-in screen (Continue with Google / Continue with GitHub) and a workspace Members interface.

**Explicitly out of scope (deferred):** a user-facing workspace *switcher*. The membership model, invites, Google auth, and members list ship now. A user who belongs to multiple workspaces lands on their earliest workspace by default; accepting an invite makes the newly-joined workspace active. No sidebar switcher is wired up in this change.

### Terminology

The DB layer says **tenant**; the UI says **Workspace**. They are the same concept (mirrors the existing `tenant_members` table). New DB objects use the `tenant_` prefix; new UI copy says "Workspace".

## 2. Architecture fit & the central constraint

The foundation is favorable — the schema is **already many-to-many**:

- `tenant_members` (`src/db/schema.ts`) is a real join table: composite PK `(tenant_id, user_id)`, a `tenant_role` enum (`owner` / `member`), cascade FKs. It has existed since migration `0000`.
- Every domain table is `tenantId`-scoped, and every server action / page already gates on `requireSession()` then filters `WHERE tenantId = session.user.tenantId`.

The gaps are all in **application logic**, not schema:

- Auth is **NextAuth v4, JWT session strategy, no DB adapter** (`src/lib/workspace/auth.ts`). There are deliberately **no `accounts` / `sessions` tables**. On first sign-in, the `jwt` callback calls `getOrCreateTenantForUser` and bakes `userId` + `tenantId` + `role` into the JWT cookie. **That `tenantId` is fixed for the life of the cookie** — this is the central constraint.
- `getOrCreateTenantForUser` (`src/lib/workspace/tenant-bootstrap.ts`) arbitrarily returns a user's *first* membership.
- No invite/join flow, no member-management UI. `role` is carried in the session but **never enforced** anywhere yet.

**Decision (chosen): keep JWT / no-adapter; resolve the active workspace from a validated cookie.** This is the lowest-risk option — no session-strategy change, no new auth tables — and it centralizes all access control in one existing choke point, `requireSession()`.

## 3. Data model & migration

### `users` — add one column

```ts
googleId: text("google_id").unique(),   // nullable; alongside existing githubId
```

`email` remains `notNull().unique()` and is the cross-provider linking key. No `accounts` table is introduced.

### New table `tenant_invites`

One **active** reusable link per workspace; history retained for audit.

| Column | Notes |
| --- | --- |
| `id` | uuid pk |
| `tenantId` | uuid not null → `tenants(id)` on delete cascade |
| `tokenHash` | text not null **unique** — SHA-256 hex of the raw token. The raw token is **never persisted**. |
| `createdByUserId` | uuid → `users(id)` (nullable; `on delete set null` so an invite outlives its creator) |
| `expiresAt` | timestamptz not null |
| `revokedAt` | timestamptz nullable |
| `createdAt` | timestamptz not null default now() |

Plus a **partial unique index**:

```sql
CREATE UNIQUE INDEX tenant_invites_one_active_per_tenant
  ON tenant_invites (tenant_id) WHERE revoked_at IS NULL;
```

This guarantees **at most one active link per workspace** and makes concurrent mints safe (one wins, the loser retries).

`tenant_members` is unchanged — we simply start inserting `member` rows.

### Token storage: hash-only, mint-on-open

The raw token is a 256-bit secret: `crypto.randomBytes(32).toString("base64url")`. We store only `sha256(token)`. Because a hash can't be turned back into a link, **the panel mints a fresh token every time it's opened** (and on explicit Regenerate), displays it once, and **supersedes the previous active link** by stamping its `revokedAt`.

Consequences, accepted:

- An invite is valid iff `revokedAt IS NULL AND expiresAt > now()`.
- Reopening settings (or Regenerate) invalidates a previously-shared link. The link still works for **unlimited recipients** until it is superseded, revoked, or expires; "the current link" is always the most recently displayed one. This is the more secure posture (short exposure window).
- **Copy** copies the freshly-shown link. **Revoke** stamps `revokedAt`, leaving no active link.

### Migration

One migration via `drizzle-kit generate`, committed as SQL under `src/db/migrations/`. It adds `users.google_id` (nullable unique), the `tenant_invites` table, and the partial unique index. The `tenant_role` enum and `tenant_members` already exist.

## 4. Provider-agnostic auth + Google

### Provider config

Add `GoogleProvider` next to `GithubProvider` in `authOptions.providers`. Request the default `openid email profile` scopes; Google returns `email` and `email_verified`.

### Provider-agnostic upsert

Refactor `getOrCreateTenantForUser` into a provider-agnostic
`getOrCreateUserFromOAuth({ email, emailVerified, name, provider, providerAccountId })`:

1. **Security gate.** Only trust an identity whose email is verified. Google supplies `email_verified`; GitHub's provider already returns the verified primary email (pass `emailVerified: true`). If `emailVerified` is false → throw (reject sign-in). This prevents email-collision account takeover.
2. **Upsert user by email.** If a user with that email exists (from any provider), **link** the incoming provider id — set `googleId` / `githubId` if currently null — and never create a duplicate user. Otherwise insert a new user with the provider id set.
3. **Ensure a workspace.** If the user has **zero** memberships, create a default tenant + `owner` membership (today's bootstrap behavior, `deriveDefaultTenantName`). If they already have memberships, create nothing.
4. Return `{ userId, tenantId (default = earliest membership), role }`.

The `jwt` callback keeps stamping `userId` + a *default* `tenantId` + `role`; the **active** tenant is resolved per request (§5). This keeps the token flow untouched.

## 5. Active-workspace resolution

### `resolveActiveTenant(userId, cookies)` → `{ tenantId, role }`

1. Read the httpOnly `activeTenantId` cookie.
2. If present, verify a `tenant_members` row exists for `(cookie tenantId, userId)`. If valid → use it (and its role).
3. Else fall back to the user's **earliest** membership (order by `createdAt`, then `tenantId`), and set the cookie to it.
4. If the user has **zero** memberships → caller signs the user out.

Cookie attributes: `httpOnly`, `secure` (prod), `sameSite=lax`, `path=/`.

### `requireSession()` — the single choke point

`requireSession()` (`src/lib/workspace/session.ts`) becomes the one place that resolves the active tenant. After loading the session it calls `resolveActiveTenant`, **sets `session.user.tenantId` (and `role`) to the resolved active values**, and returns. Because every existing call site already reads `session.user.tenantId`, they all keep working **unchanged** and are now automatically membership-validated.

- Zero memberships → `redirect("/api/auth/signout")`.
- Cookie pointing at a non-member tenant → ignored and reset to the earliest membership.
- This replaces today's `tenantExists` PK check with a stronger `is-member-of-active-tenant` check.

**Why URL tampering can't grant access:** there is no tenant id in any URL; the active tenant comes only from the cookie, which is always validated against `tenant_members`. Setting the cookie to a workspace you don't belong to fails the membership check and is discarded.

`setActiveTenant(tenantId)` (a server-side helper that writes the validated cookie) is used by the invite-accept flow, and later by the deferred switcher.

## 6. Invite accept flow

Route: **`/invite/[token]`** — the token is a path segment; **no tenant id in the URL**.

1. **Load.** Hash the path token, look up `tenant_invites` by `tokenHash`. Render one of: **invalid** (no match), **expired** (`expiresAt <= now()`), **revoked** (`revokedAt` set), or **valid** (show "You've been invited to join *{workspace name}*").
2. **Unauthenticated + valid.** Show Continue with Google / Continue with GitHub. Buttons call `signIn(provider, { callbackUrl: "/invite/<token>" })` so the OAuth round-trip returns to the invite page — **the invitation context is preserved** because the token lives in the URL.
3. **Authenticated + valid → Accept** (server action):
   - Re-validate the invite (not expired / revoked).
   - `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES (..., 'member') ON CONFLICT (tenant_id, user_id) DO NOTHING`. The composite PK + `ON CONFLICT` make joins **idempotent and concurrency-safe** — existing members are not re-added, and concurrent accepts create exactly one membership.
   - `setActiveTenant(tenantId)` so the user lands in the new workspace; redirect to the dashboard.
4. **Already a member.** Detected (membership already present) → a clear "You're already a member of *{workspace}*" success state, then continue into the workspace. Not added twice.

**Reuse policy (defined):** a still-valid link accepts many recipients until it is superseded/revoked/expired. Accepting while already a member is a successful no-op. The link is not single-use.

## 7. Authorization

- A small `requireRole(session, "owner")` helper (extensible to `admin` later) gates invite **generate / regenerate / revoke**. Viewing the member list is allowed to any member.
- All new server actions run through `requireSession()` and scope by the resolved active tenant.
- Invite-by-token lookups never expose or accept a tenant id; they resolve the tenant from the (hashed) token alone.

## 8. UI

Stack: shadcn/ui on **Base UI** (`@base-ui/react`), Tailwind v4, lucide-react, **sonner** toasts (matches the codebase).

- **Custom sign-in page `/signin`** wired via `authOptions.pages.signIn`, replacing the default NextAuth screen. Two branded buttons: **Continue with Google**, **Continue with GitHub**, each calling `signIn(provider, { callbackUrl })`. It honors an incoming `callbackUrl` (used by the invite flow).
- **Settings → Members section** (extends the existing `src/app/(dashboard)/settings/` page):
  - **Member list** — name / email + role, from `tenant_members ⋈ users`, scoped to the active tenant. Visible to any member.
  - **Invite link card** — owner-only. Shows the freshly-minted link with a **Copy** button, plus **Regenerate** and **Revoke**, and the expiry. Success / error / empty states via toasts.
- **Invite page states** — valid (sign-in or accept), invalid, expired, revoked, already-a-member — each a clear message.

## 9. Assumptions & operational notes

- New env vars: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `INVITE_LINK_TTL_DAYS` (default `7`). Added to `.env.example`. Google sign-in is only offered when its env is configured.
- Next.js 16.2.10 here is customized (per `AGENTS.md`). Before writing the `cookies()` usage, the custom sign-in page, and any route-handler code, read the relevant guide under `node_modules/next/dist/docs/`.
- Deferred switcher: multi-membership users default to their earliest workspace; the sidebar's existing switcher-shaped dropdown is left as-is.

## 10. Testing (Vitest against the real `_test` DB)

The harness runs against a Postgres database whose name must end in `_test` (`vitest.setup.ts`), importing the real `db`, cleaning up per-test.

- **Schema.** `tenant_invites` round-trip; `tokenHash` uniqueness; the partial unique index rejects a second active row per tenant; `users.google_id` uniqueness.
- **Provider-agnostic upsert.** New Google user → creates tenant + owner. Existing GitHub user signs in via Google with the same verified email → links `googleId`, no duplicate user, no new tenant. Unverified email → rejected.
- **Invite lifecycle.** Generate → valid; hash lookup succeeds for the raw token; Regenerate supersedes (prior link becomes invalid); Revoke invalidates; expired link is invalid.
- **Accept flow.** Non-member joins (membership row created); already-member accept → no duplicate; **concurrent accept → single membership** (ON CONFLICT); expired / revoked token → error.
- **Active-tenant resolution.** Valid cookie honored; cookie for a non-member tenant rejected and reset to earliest membership; zero-membership → sign-out path.
- **Authorization.** Non-owner cannot generate / regenerate / revoke an invite.
