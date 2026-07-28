# Onboarding upgrade: work-email-only signup + four-step wizard

Date: 2026-07-28

## Goals

1. Stop personal email accounts (gmail.com, outlook.com, …) from creating new users and workspaces. Land them on a dedicated page explaining why, with a button to sign in again using a corporate account.
2. Replace the single stacked-card onboarding page with a four-step wizard: one decision per screen.

## Non-goals

- Domain verification, SSO, or per-workspace domain allowlists.
- Changing the invite mechanism (still a single link-based token per tenant).
- Reworking the Integrations page.

---

## Part 1 — Work-email-only signup

### Decisions

| Question | Decision |
|---|---|
| Invited personal-email users | **Allowed.** The block stops self-serve signup, not a deliberate invite. |
| Users that already exist with a personal email | **Grandfathered.** Enforcement happens only when a workspace would be created. |
| Domain source | **Curated list in-repo.** No dependency; extend when a miss shows up. |
| Escape hatch | **`ALLOWED_PERSONAL_EMAILS` env var**, comma-separated. |
| Enforcement shape | **"No workspace" state** — the user row is created, the tenant is not. |

### Why the "no workspace" state

Invites are link-based, not email-bound: the token lives only in the URL, and
`getOrCreateUserFromOAuth` runs inside the NextAuth `jwt` callback, which never
sees it. Rejecting at `signIn` would therefore need an invite-intent cookie set
by `/invite/[token]` — extra plumbing whose failure mode is silently locking out
invited users.

Instead, a personal-email signup produces a user with **no membership**.
`requireSession()` already has a no-membership branch (today it force-signs-out),
so the blocked state costs one changed redirect. Accepting an invite grants a
membership, which unblocks the account with no special-casing anywhere.

### `src/lib/workspace/email-domain.ts` (new)

```ts
export function isPersonalEmail(email: string): boolean
```

- Trim, lowercase, take the segment after the **last** `@`.
- Return `false` immediately if the full address is listed in
  `ALLOWED_PERSONAL_EMAILS` (comma-separated, trimmed, compared lowercased).
- Otherwise return whether the domain is in `PERSONAL_EMAIL_DOMAINS`.
- Exact domain match only. `gmail.com.attacker.dev` is not gmail; `mail.acme.com`
  is not blocked because `acme.com` is not in the set.

`PERSONAL_EMAIL_DOMAINS` seed (~40): gmail.com, googlemail.com, outlook.com,
outlook.co.uk, hotmail.com, hotmail.co.uk, hotmail.fr, live.com, live.co.uk,
msn.com, yahoo.com, yahoo.co.uk, yahoo.co.in, yahoo.fr, ymail.com, rocketmail.com,
icloud.com, me.com, mac.com, aol.com, protonmail.com, proton.me, pm.me, gmx.com,
gmx.de, gmx.net, web.de, mail.com, mail.ru, yandex.com, yandex.ru, zoho.com,
fastmail.com, hey.com, tutanota.com, tuta.io, qq.com, 163.com, 126.com,
naver.com, hanmail.net, daum.net.

Pure function, no DB or network. Env is read at call time so tests can set it.

### `getOrCreateUserFromOAuth` (changed)

`src/lib/workspace/tenant-bootstrap.ts`

Return type becomes a union:

```ts
export type SessionTenantInfo =
  | { userId: string; tenantId: string; role: "owner" | "member" }
  | { userId: string; tenantId: null; role: null };
```

New order of operations:

1. Reject unverified emails (unchanged).
2. Find or create the user by email (unchanged).
3. **Return early if the user already has a membership** (unchanged).
4. **If `isPersonalEmail(input.email)` → return `{ userId, tenantId: null, role: null }`.** No tenant, no membership.
5. Otherwise create the tenant and owner membership (unchanged).

Step 4 sits *after* step 3 deliberately. Grandfathered users and invitees both
have a membership by the time the check would run, so neither needs its own
branch. This ordering is the whole mechanism — a test asserts it directly.

### Session types (changed)

`src/types/next-auth.d.ts`: `tenantId` becomes `string | null` and `role`
becomes `"owner" | "member" | null` **on `JWT` only**. `Session["user"]` keeps
`tenantId: string` and `role: "owner" | "member"`.

Widening `Session` instead would hit all 131 `session.user.tenantId` reads in
`src/`. Confining it to `JWT` touches exactly one: the `session` callback in
`auth.ts`.

Confining it is also the *correct* choice, not merely the cheap one. The
non-null `Session` type states the post-condition of `requireSession()`, which
redirects when there is no membership and always stamps a real tenant — and
`requireSession()` is the only sanctioned producer of a session. The three
`getServerSession` callers were audited: `/api/drafts/edit` and
`/api/atomic-updates/draft` never read `session.user.tenantId` (both call
`resolveActiveTenant` and return 401 when it is null), and `/invite/[token]`
reads only `user.id`. No caller can observe the difference.

The `session` callback assigns `token.tenantId ?? ""`. The empty string means
"unresolved — you did not go through `requireSession()`", and it fails closed:
`""` is not a valid uuid, so any tenant-scoped query built from it errors loudly
in Postgres rather than returning another tenant's rows. Document this on the
callback.

### `requireSession()` (changed)

`src/lib/workspace/session.ts` — the `!active` branch redirects to
`/work-email-required` instead of `/api/auth/signout`.

The old comment about a valid JWT with no membership (deleted workspace, wiped
DB) still applies; those users now land on the same page. Its copy is written to
cover both cases: it explains the work-email requirement and offers sign-out,
which is the correct remedy either way.

### `requireUser()` (new)

`src/lib/workspace/session.ts`

```ts
export async function requireUser(): Promise<{ id: string }>
```

Returns the session user id, redirecting to `/signin` when unauthenticated. It
performs **no** tenant resolution, so it works for a membership-less user.

This is the load-bearing change for the invitee path: `acceptInvite` currently
calls `requireSession()`, which would bounce a blocked user to
`/work-email-required` before they could ever accept.

### `acceptInvite` (changed)

`src/app/invite/[token]/accept-actions.ts` — swap `requireSession()` for
`requireUser()`. Everything after is unchanged: `acceptInviteForUser` →
`setActiveTenant` → redirect to `/`. `setActiveTenant` already validates that
this user holds the membership, so dropping tenant resolution here loses no
access control.

`/invite/[token]/page.tsx` already uses `getServerSession` and needs no change.

### `/work-email-required` (new)

`src/app/work-email-required/page.tsx`

- Uses `getServerSession`, **never** `requireSession()` — the latter would loop.
- If the visitor turns out to have a membership, redirect to `/`. Prevents a
  stale bookmark stranding a valid user.
- Layout mirrors `/signin`: centered `Logo`, heading, one paragraph, one card.
- Copy names the signed-in address so the user understands what was rejected.
- Single button → `/api/auth/signout?callbackUrl=/signin`. Signing out first is
  required: without it the provider silently re-picks the same personal account
  and the user loops back here.

---

## Part 2 — Four-step wizard

### Decisions

| Question | Decision |
|---|---|
| Schedule step | **Kept as step 4.** |
| Repo selection | **Sub-step inside step 3**, revealed after GitHub connects. |
| GitHub vs Notion | **Both offered on step 3**; connecting either is enough, both is fine. |
| Notion database picker | **Included as a sub-step**, mirroring repo selection. |
| Routing | **Route per step.** |
| Resume point | **Furthest incomplete step.** |
| Skip | **Per-step only** on steps 2 and 3. The global "Skip for now" is removed. |

### Progress tracking

Migration adds `tenants.onboarding_step` — `integer NOT NULL DEFAULT 1`.

An explicit column rather than inference from other tables, because:

- Steps 2 and 3 are skippable, so their DB artifacts (brand profile URL, GitHub
  installation) can't distinguish "skipped" from "not reached".
- `tenants.name` is auto-derived at signup by `deriveDefaultTenantName`, so it is
  never empty and can't signal whether step 1 was answered.

Existing tenants get `1` from the default. They are unaffected in practice:
anyone already past onboarding has `onboarding_completed_at` set, which is
checked first and short-circuits to the dashboard.

### Routes

All under `src/app/onboarding/`:

| Path | Step | Contents |
|---|---|---|
| `page.tsx` | — | Redirects to the stored step. Remains a valid OAuth return target. |
| `layout.tsx` | — | Shared shell: `Logo`, "Step N of 4", progress dots, consistent card width. |
| `workspace/page.tsx` | 1 | Workspace name. Required; pre-filled with the derived default so it is one click. |
| `brand/page.tsx` | 2 | Updates-page URL + "Skip this step". |
| `connect/page.tsx` | 3 | GitHub and Notion cards, each revealing its sub-step once connected. One footer control: "Continue" when at least one integration is connected, "Skip this step" when none is. Never both — with nothing connected they would do the same thing. |
| `schedule/page.tsx` | 4 | Cadence + threshold. "Finish". |

The current `src/app/onboarding/page.tsx` is deleted; its four cards are split
across the step pages. The repo-selection markup moves verbatim into
`connect/page.tsx`, including the existing per-repo `try/catch` around
`listRepoBranches` (one failing repo must not crash the screen).

### Step guard

`src/lib/workspace/onboarding-step.ts` (new) holds the pure decision:

```ts
export type OnboardingStep = 1 | 2 | 3 | 4;
export function resolveOnboardingRedirect(
  args: { completed: boolean; storedStep: number; requestedStep: OnboardingStep }
): string | null;
```

Returns the path to redirect to, or `null` to render. Rules:

- `completed` → `/atomic-updates`.
- `storedStep < requestedStep` → the path for `storedStep` (no jumping ahead into
  a screen whose prerequisites are unanswered).
- Otherwise `null`. Revisiting an **earlier** step is allowed, so browser Back works.

Each step page calls it with its own number. Kept pure so it is unit-tested
without a DB.

### Actions

`src/app/onboarding/actions.ts` stays a single file. Every action advances
`onboarding_step` and redirects.

Advancement is monotonic. A shared helper writes
`onboarding_step = GREATEST(onboarding_step, $next)` in SQL, so re-submitting an
earlier step (browser Back, then Save) cannot rewind someone who has already
reached a later step. Doing this in SQL rather than read-then-write also avoids
a lost update when the GitHub OAuth return and a form submit race.

| Action | Effect |
|---|---|
| `saveWorkspaceName` | Reject empty/whitespace name by returning to step 1; else save, step → 2, redirect `/onboarding/brand`. |
| `importBrandStyle` | Success: step → 3, redirect `/onboarding/connect`. Failure: stay on step 2 with `?brandImport=failed`. |
| `skipBrandStep` | Step → 3, redirect `/onboarding/connect`. |
| `addOnboardingRepos` | Unchanged logic; redirect `/onboarding/connect`. |
| `saveNotionDatabase` | Reuses the existing Notion database/status-property save; redirect `/onboarding/connect`. |
| `continueFromConnect` | Step → 4, redirect `/onboarding/schedule`. |
| `skipConnectStep` | Step → 4, redirect `/onboarding/schedule`. |
| `saveOnboardingSchedule` | Unchanged: write schedule config, `markOnboardingComplete`, redirect `/atomic-updates`. |

`skipOnboarding` is deleted along with the header control that called it.

### OAuth return paths

**GitHub already works.** `/api/github/connect?returnTo=onboarding` and
`/api/github/setup` resolve `returnTo === "onboarding"` to `/onboarding`, which
now redirects by stored step — landing the user back on `/onboarding/connect`.

**Notion does not.** `src/app/api/notion/callback/route.ts` hardcodes
`/integrations` on all three of its exits (two error, one success). It needs the
same `returnTo` treatment GitHub has:

- `/api/notion/connect` accepts `?returnTo=`, validated against an allowlist of
  `{"integrations", "onboarding"}`, defaulting to `integrations` so existing
  callers are unaffected.
- Carry the value inside the existing signed OAuth `state` rather than a second
  cookie — `src/lib/integrations/oauth-state.ts` already builds and verifies
  state, and GitHub's `setup` route uses the same pattern.
- The callback resolves it to `/onboarding/connect?notion_connect=…` or
  `/integrations?notion_connect=…`, preserving the existing query flags.

This is the largest single piece of work in Part 2 and should not be folded into
the UI task.

---

## Testing

New:

- `tests/lib/workspace/email-domain.test.ts` — personal vs corporate; uppercase
  and mixed case; plus-addressing (`a+b@gmail.com`); subdomain lookalikes
  (`mail.acme.com` allowed, `gmail.com.evil.dev` allowed since it is not an exact
  match); `ALLOWED_PERSONAL_EMAILS` hit and miss; malformed input with no `@`.
- `tests/lib/workspace/onboarding-step.test.ts` — `resolveOnboardingRedirect`
  across completed / behind / at / ahead-of the stored step.

Extended:

- `tests/lib/workspace/tenant-bootstrap.test.ts` — three sign-in cases: personal
  email creates a user but no tenant and no membership; an existing user with a
  personal email keeps their membership (grandfathered); a personal-email user
  who holds a membership resolves normally (the invitee case).
- `tests/lib/workspace/onboarding.test.ts` — step advancement never moves
  backward.
- `tests/lib/workspace/accept-invite.test.ts` — a membership-less user can accept.

## Risks

- ~~**Nullable `tenantId` fan-out.**~~ Resolved during planning: confining the
  widening to `JWT` cuts the blast radius from 131 call sites to 1, and an audit
  of the three `getServerSession` callers confirmed none can observe the
  difference. See "Session types" above.
- **Notion `returnTo` touches a live OAuth path.** The `/integrations` flow must
  keep working unchanged; the allowlist default of `integrations` is what
  guarantees that.
- **Curated domain list will have misses.** Accepted: a miss lets one personal
  account through, which is recoverable. A false positive would block a real
  customer, which is why matching is exact-domain-only.
