# Onboarding Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop personal email addresses from creating workspaces, and replace the single stacked-card onboarding page with a four-step wizard.

**Architecture:** A personal-email signup creates a user row but no tenant, so it has no membership; `requireSession()`'s existing no-membership branch routes those users to a `/work-email-required` page, and accepting an invite grants a membership that unblocks them with no special-casing. The wizard becomes four route segments under `/onboarding`, with progress stored in a new `tenants.onboarding_step` column and a pure guard function deciding redirects.

**Tech Stack:** Next.js App Router (server components + server actions), NextAuth v4 (JWT strategy), Drizzle ORM + Postgres, Vitest, Tailwind + shadcn-style UI primitives.

**Spec:** `docs/superpowers/specs/2026-07-28-onboarding-upgrade-design.md`

## Global Constraints

- **Read the Next.js docs first.** Per `AGENTS.md`: this repo's Next.js has breaking changes versus training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing route/page code. `params` and `searchParams` are `Promise`s and must be awaited — follow the existing pages.
- **Tests run against real Postgres**, not mocks. `vitest.setup.ts` hard-fails unless the database name ends in `_test`. Run `npm run db:migrate:test` after any schema change, before running tests.
- **Commands:** `npm test` (vitest run), `npm run typecheck` (tsc --noEmit), `npm run lint` (eslint), `npm run db:generate` (drizzle-kit generate), `npm run db:migrate` / `npm run db:migrate:test`.
- **Import alias:** `@/` → `src/`. Production code uses `@/…`. Tests use relative paths (`../../../src/…`) — match the file you are next to.
- **Do not widen `Session["user"].tenantId`.** Only `JWT` becomes nullable. 131 call sites depend on the non-null `Session` type, which states the post-condition of `requireSession()`.
- **Every DB-touching test cleans up in `afterEach`**, keyed on a distinctive constant (see `tests/lib/workspace/onboarding.test.ts` for the pattern).
- **Commit after every task.** Conventional commit prefixes (`feat:`, `fix:`, `refactor:`, `test:`).

---

## File Structure

**Part 1 — work-email gate**

| File | Responsibility |
|---|---|
| `src/lib/workspace/email-domain.ts` (new) | Pure: is this address a personal-provider address? |
| `src/lib/workspace/tenant-bootstrap.ts` (modify) | Skip tenant creation for personal emails |
| `src/types/next-auth.d.ts` (modify) | `JWT.tenantId`/`JWT.role` nullable |
| `src/lib/workspace/auth.ts` (modify) | Session callback coerces null → `""` |
| `src/lib/workspace/session.ts` (modify) | `requireUser()`; no-membership redirect target |
| `src/app/invite/[token]/accept-actions.ts` (modify) | Use `requireUser()` |
| `src/app/work-email-required/page.tsx` (new) | The blocked page |
| `src/app/work-email-required/signout-button.tsx` (new) | Client component: real sign-out via `signOut()` |

**Part 2 — wizard**

| File | Responsibility |
|---|---|
| `src/db/schema.ts` (modify) | `tenants.onboarding_step` |
| `src/lib/workspace/onboarding-step.ts` (new) | Pure step/redirect resolution + path table |
| `src/lib/workspace/onboarding.ts` (modify) | `getOnboardingState`, `advanceOnboardingStep` |
| `src/app/api/notion/connect/route.ts` (modify) | Accept `?returnTo=` |
| `src/app/api/notion/callback/route.ts` (modify) | Honour `returnTo` from state |
| `src/app/onboarding/guard.ts` (new) | Server-side wrapper over the pure guard |
| `src/app/onboarding/layout.tsx` (new) | Wizard shell + progress |
| `src/app/onboarding/page.tsx` (replace) | Redirect to stored step |
| `src/app/onboarding/workspace/page.tsx` (new) | Step 1 |
| `src/app/onboarding/brand/page.tsx` (new) | Step 2 |
| `src/app/onboarding/connect/page.tsx` (new) | Step 3 |
| `src/app/onboarding/schedule/page.tsx` (new) | Step 4 |
| `src/app/onboarding/actions.ts` (modify) | Step-advancing server actions |

---

## Task 1: Personal-email detection

**Files:**
- Create: `src/lib/workspace/email-domain.ts`
- Test: `tests/lib/workspace/email-domain.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isPersonalEmail(email: string): boolean` — used by Task 2.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/workspace/email-domain.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { isPersonalEmail } from "../../../src/lib/workspace/email-domain";

describe("isPersonalEmail", () => {
  afterEach(() => {
    delete process.env.ALLOWED_PERSONAL_EMAILS;
  });

  it("flags well-known personal providers", () => {
    expect(isPersonalEmail("someone@gmail.com")).toBe(true);
    expect(isPersonalEmail("someone@outlook.com")).toBe(true);
    expect(isPersonalEmail("someone@yahoo.co.uk")).toBe(true);
    expect(isPersonalEmail("someone@proton.me")).toBe(true);
    expect(isPersonalEmail("someone@qq.com")).toBe(true);
  });

  it("allows company domains", () => {
    expect(isPersonalEmail("tomer@frontitude.com")).toBe(false);
    expect(isPersonalEmail("dev@acme.io")).toBe(false);
  });

  it("normalises case and surrounding whitespace", () => {
    expect(isPersonalEmail("  Someone@GMAIL.com ")).toBe(true);
  });

  it("flags plus-addressed personal accounts", () => {
    expect(isPersonalEmail("someone+versional@gmail.com")).toBe(true);
  });

  // Matching is exact-domain-only, in both directions. A company subdomain is
  // not its parent, and a lookalike suffix is not the real provider.
  it("matches the domain exactly, never as a substring or suffix", () => {
    expect(isPersonalEmail("someone@mail.acme.com")).toBe(false);
    expect(isPersonalEmail("someone@gmail.com.evil.dev")).toBe(false);
    expect(isPersonalEmail("someone@notgmail.com")).toBe(false);
  });

  it("splits on the LAST @, so a quoted local part cannot spoof the domain", () => {
    expect(isPersonalEmail('"foo@acme.com"@gmail.com')).toBe(true);
  });

  it("lets an explicitly allowlisted address through", () => {
    process.env.ALLOWED_PERSONAL_EMAILS = "demo@gmail.com, other@yahoo.com";
    expect(isPersonalEmail("demo@gmail.com")).toBe(false);
    expect(isPersonalEmail("DEMO@GMAIL.COM")).toBe(false);
    expect(isPersonalEmail("someoneelse@gmail.com")).toBe(true);
  });

  it("reads the allowlist at call time, not at import time", () => {
    expect(isPersonalEmail("late@gmail.com")).toBe(true);
    process.env.ALLOWED_PERSONAL_EMAILS = "late@gmail.com";
    expect(isPersonalEmail("late@gmail.com")).toBe(false);
  });

  // Fails open: mapOAuthProfile already guarantees a provider-supplied address
  // and getOrCreateUserFromOAuth already rejects unverified ones, so there is no
  // path where a malformed string reaches a workspace.
  it("does not flag a malformed address with no domain", () => {
    expect(isPersonalEmail("no-at-sign")).toBe(false);
    expect(isPersonalEmail("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lib/workspace/email-domain.test.ts`
Expected: FAIL — cannot resolve `src/lib/workspace/email-domain`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/workspace/email-domain.ts`:

```ts
/**
 * Free/consumer email providers. Personal addresses may not create a workspace
 * — see `getOrCreateUserFromOAuth`.
 *
 * Deliberately a curated list rather than an exhaustive package: a miss lets one
 * personal account through, which is recoverable, whereas a false positive
 * blocks a real customer. Add entries as misses show up.
 */
const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com",
  "outlook.com", "outlook.co.uk", "hotmail.com", "hotmail.co.uk", "hotmail.fr",
  "live.com", "live.co.uk", "msn.com",
  "yahoo.com", "yahoo.co.uk", "yahoo.co.in", "yahoo.fr", "ymail.com", "rocketmail.com",
  "icloud.com", "me.com", "mac.com",
  "aol.com",
  "protonmail.com", "proton.me", "pm.me",
  "gmx.com", "gmx.de", "gmx.net", "web.de",
  "mail.com", "mail.ru", "yandex.com", "yandex.ru",
  "zoho.com", "fastmail.com", "hey.com", "tutanota.com", "tuta.io",
  "qq.com", "163.com", "126.com",
  "naver.com", "hanmail.net", "daum.net",
]);

/**
 * Escape hatch for demos and prod-like testing: a comma-separated list of full
 * addresses that bypass the check. Read at call time so tests (and a redeploy-free
 * env change) take effect without a module reload.
 */
function allowlisted(normalizedEmail: string): boolean {
  return (process.env.ALLOWED_PERSONAL_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalizedEmail);
}

export function isPersonalEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  // Split on the LAST "@": the domain is what follows it, so a local part that
  // itself contains "@" (legal when quoted) cannot spoof a company domain.
  const at = normalized.lastIndexOf("@");
  if (at === -1) return false;
  if (allowlisted(normalized)) return false;
  return PERSONAL_EMAIL_DOMAINS.has(normalized.slice(at + 1));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lib/workspace/email-domain.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workspace/email-domain.ts tests/lib/workspace/email-domain.test.ts
git commit -m "feat: detect personal email domains"
```

---

## Task 2: Personal emails get no workspace

**Files:**
- Modify: `src/lib/workspace/tenant-bootstrap.ts`
- Modify: `src/types/next-auth.d.ts`
- Modify: `src/lib/workspace/auth.ts`
- Test: `tests/lib/workspace/tenant-bootstrap.test.ts`

**Interfaces:**
- Consumes: `isPersonalEmail(email: string): boolean` from Task 1.
- Produces: `SessionTenantInfo` is now a union — `{ userId: string; tenantId: string; role: "owner" | "member" }` or `{ userId: string; tenantId: null; role: null }`. Task 3 relies on a membership-less user reaching `requireSession()`.

- [ ] **Step 1: Write the failing tests**

Append these three cases inside the existing `describe("getOrCreateUserFromOAuth", …)` block in `tests/lib/workspace/tenant-bootstrap.test.ts`.

The existing `afterEach` cleans up only `EMAIL`. Add a second constant and extend cleanup. Replace the top-of-file constant and `afterEach` with:

```ts
const EMAIL = "newperson@frontitude.com";
const PERSONAL_EMAIL = "newperson@gmail.com";

async function cleanupUser(email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) return;
  const memberships = await db.select().from(tenantMembers).where(eq(tenantMembers.userId, user.id));
  await db.delete(tenantMembers).where(eq(tenantMembers.userId, user.id));
  const tenantIds = memberships.map((m) => m.tenantId);
  if (tenantIds.length) await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  await db.delete(users).where(eq(users.id, user.id));
}
```

and make `afterEach` call it for both addresses:

```ts
  afterEach(async () => {
    await cleanupUser(EMAIL);
    await cleanupUser(PERSONAL_EMAIL);
    delete process.env.ALLOWED_PERSONAL_EMAILS;
  });
```

Then add the new cases:

```ts
  it("creates the user but NO workspace for a personal email", async () => {
    const result = await getOrCreateUserFromOAuth({
      email: PERSONAL_EMAIL, emailVerified: true, name: "Personal", provider: "google", providerAccountId: "g-p1",
    });

    expect(result.tenantId).toBeNull();
    expect(result.role).toBeNull();

    // The user row IS created — that is what lets them accept an invite later.
    const [user] = await db.select().from(users).where(eq(users.id, result.userId));
    expect(user.email).toBe(PERSONAL_EMAIL);

    const memberships = await db.select().from(tenantMembers).where(eq(tenantMembers.userId, result.userId));
    expect(memberships).toHaveLength(0);
  });

  // The invitee case. Membership is looked up BEFORE the personal-email check,
  // so anyone who already belongs somewhere resolves normally. This ordering is
  // the entire mechanism for both invitees and grandfathered accounts.
  it("resolves normally for a personal email that already holds a membership", async () => {
    const first = await getOrCreateUserFromOAuth({
      email: PERSONAL_EMAIL, emailVerified: true, name: "Personal", provider: "google", providerAccountId: "g-p2",
    });
    const [tenant] = await db.insert(tenants).values({ name: "Invited Into" }).returning({ id: tenants.id });
    await db.insert(tenantMembers).values({ tenantId: tenant.id, userId: first.userId, role: "member" });

    const second = await getOrCreateUserFromOAuth({
      email: PERSONAL_EMAIL, emailVerified: true, name: "Personal", provider: "google", providerAccountId: "g-p2",
    });

    expect(second.userId).toBe(first.userId);
    expect(second.tenantId).toBe(tenant.id);
    expect(second.role).toBe("member");
  });

  it("honours ALLOWED_PERSONAL_EMAILS and creates a workspace anyway", async () => {
    process.env.ALLOWED_PERSONAL_EMAILS = PERSONAL_EMAIL;

    const result = await getOrCreateUserFromOAuth({
      email: PERSONAL_EMAIL, emailVerified: true, name: "Demo", provider: "google", providerAccountId: "g-p3",
    });

    expect(result.tenantId).not.toBeNull();
    expect(result.role).toBe("owner");
  });
```

The existing test `creates user + tenant + owner membership for a new Google user` reads `result.tenantId` where the union now allows `null`. Narrow it by asserting first — change its body to add `expect(result.tenantId).not.toBeNull();` immediately after the call, then use a non-null local:

```ts
    expect(result.role).toBe("owner");
    expect(result.tenantId).not.toBeNull();
    const tenantId = result.tenantId as string;
    const [user] = await db.select().from(users).where(eq(users.id, result.userId));
    expect(user.googleId).toBe("g-1");
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(tenant.name).toBe("Frontitude's Workspace");
```

Also clean up the extra tenant the invitee test creates — extend `afterEach` with:

```ts
    await db.delete(tenants).where(eq(tenants.name, "Invited Into"));
```

(place it after both `cleanupUser` calls, since the membership rows must go first).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/workspace/tenant-bootstrap.test.ts`
Expected: FAIL — the personal-email case creates a tenant, so `result.tenantId` is a string, not `null`.

- [ ] **Step 3: Update `getOrCreateUserFromOAuth`**

In `src/lib/workspace/tenant-bootstrap.ts`, add the import:

```ts
import { isPersonalEmail } from "./email-domain";
```

Replace the `SessionTenantInfo` type:

```ts
/**
 * A signed-in user either belongs to a workspace or does not. `tenantId: null`
 * means the account exists but has no workspace — today that is a personal-email
 * signup, which `requireSession()` routes to /work-email-required.
 */
export type SessionTenantInfo =
  | { userId: string; tenantId: string; role: "owner" | "member" }
  | { userId: string; tenantId: null; role: null };
```

Then, in the body, insert the gate between the existing membership lookup and the tenant insert:

```ts
  if (existingMembership) {
    return { userId, tenantId: existingMembership.tenantId, role: existingMembership.role };
  }

  // Work-email gate. Deliberately placed AFTER the membership lookup: anyone who
  // already belongs to a workspace — a grandfathered account, or someone invited
  // into a corporate workspace — resolves above and never reaches here. So this
  // only ever blocks the creation of a NEW workspace by a personal address.
  if (isPersonalEmail(input.email)) {
    return { userId, tenantId: null, role: null };
  }

  const [tenant] = await database
    .insert(tenants)
    .values({ name: deriveDefaultTenantName(input.email) })
    .returning({ id: tenants.id });
```

- [ ] **Step 4: Widen the JWT type**

Replace the `next-auth/jwt` block in `src/types/next-auth.d.ts` (leave the `next-auth` `Session` block untouched):

```ts
declare module "next-auth/jwt" {
  interface JWT {
    userId: string;
    // Null when the account has no workspace (personal-email signup). Session
    // stays non-null: requireSession() is its only sanctioned producer and it
    // redirects rather than returning a workspace-less session.
    tenantId: string | null;
    role: "owner" | "member" | null;
  }
}
```

- [ ] **Step 5: Coerce in the session callback**

In `src/lib/workspace/auth.ts`, replace the two assignments in the `session` callback:

```ts
    async session({ session, token }: { session: Session; token: JWT }) {
      session.user.id = token.userId;
      // "" / "member" are placeholders for a workspace-less token. requireSession()
      // overwrites both from real membership rows on every request and is the only
      // sanctioned way to obtain a session, so nothing should ever read these.
      // They fail closed if something does: "" is not a valid uuid, so a
      // tenant-scoped query built from it errors in Postgres rather than
      // silently matching another workspace's rows.
      session.user.tenantId = token.tenantId ?? "";
      session.user.role = token.role ?? "member";
      return session;
    },
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run tests/lib/workspace/tenant-bootstrap.test.ts && npm run typecheck`
Expected: all tests PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/workspace/tenant-bootstrap.ts src/types/next-auth.d.ts src/lib/workspace/auth.ts tests/lib/workspace/tenant-bootstrap.test.ts
git commit -m "feat: skip workspace creation for personal email signups"
```

---

## Task 3: Route workspace-less users, keep invites working

**Files:**
- Modify: `src/lib/workspace/session.ts`
- Modify: `src/app/invite/[token]/accept-actions.ts`
- Test: `tests/lib/workspace/session.test.ts`

**Interfaces:**
- Consumes: the `tenantId: null` path from Task 2.
- Produces: `requireUser(): Promise<{ id: string }>` — no other task consumes it, but Task 4's page relies on `requireSession()` redirecting to `/work-email-required`.

- [ ] **Step 1: Write the failing test**

`tests/lib/workspace/session.test.ts` does **not** mock `next/navigation` — it uses the real `redirect()` and asserts on the thrown error's `digest`. Follow that pattern exactly; do not add a redirect mock.

Add inside the existing `describe("requireSession", …)` block:

```ts
  // A signed-in user with no membership is now a real, expected state: a
  // personal-email signup gets a user row but no workspace. Sending them to
  // signout would just loop them through the same blocked sign-in; the page
  // explains why and offers the remedy.
  it("sends a signed-in user with no workspace to /work-email-required", async () => {
    const [user] = await db.insert(users).values({ email: emails[0] }).returning();
    const session = {
      user: { id: user.id, tenantId: "stale-id", role: "member" },
      expires: "",
    } as unknown as Session;
    vi.mocked(getServerSession).mockResolvedValue(session as never);

    let caught: unknown;
    try {
      await requireSession();
    } catch (err) {
      caught = err;
    }

    const digest = (caught as { digest?: unknown }).digest;
    expect(typeof digest).toBe("string");
    expect(digest as string).toMatch(/^NEXT_REDIRECT/);
    expect(digest as string).toContain("/work-email-required");
    expect(digest as string).not.toContain("/api/auth/signout");
  });
```

The block's existing `emails` array and `afterEach` already handle cleanup for this user.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/lib/workspace/session.test.ts`
Expected: FAIL — redirect called with `/api/auth/signout`, not `/work-email-required`.

- [ ] **Step 4: Change the redirect target and add `requireUser`**

In `src/lib/workspace/session.ts`, replace the `!active` branch:

```ts
  if (!active) {
    // No membership. Either a personal-email signup (blocked from creating a
    // workspace) or a valid JWT whose workspace is gone (deleted workspace,
    // wiped DB). The page covers both and offers sign-out, which is the remedy
    // either way.
    redirect("/work-email-required");
  }
```

Then append:

```ts
/**
 * Identity only — no workspace resolution. Use this on the few paths that must
 * work for a user who belongs to no workspace yet, chiefly accepting an invite:
 * requireSession() would bounce them to /work-email-required before they could
 * ever join the workspace that would unblock them.
 */
export async function requireUser(): Promise<{ id: string }> {
  const session = await getServerSession(authOptions);
  if (!hasValidSession(session)) {
    redirect("/signin");
  }
  return { id: session.user.id };
}
```

- [ ] **Step 5: Switch `acceptInvite` to `requireUser`**

In `src/app/invite/[token]/accept-actions.ts`, change the import and the first line of the action:

```ts
import { requireUser } from "@/lib/workspace/session";
```

```ts
export async function acceptInvite(token: string): Promise<void> {
  // requireUser, not requireSession: an invitee with a personal email has no
  // workspace yet, and requireSession() would redirect them away from the very
  // action that grants them one.
  const user = await requireUser();
  const result = await acceptInviteForUser(user.id, token);
```

and replace the two later `session.user.id` references with `user.id`.

- [ ] **Step 6: Verify a workspace-less user can accept an invite**

`tests/lib/workspace/accept-invite.test.ts` already has a `setup()` helper returning `{ t, token }`, a `makeUser(email)` helper, and an `emails` array driving `afterEach` cleanup. Reuse all three rather than hand-rolling.

First add the new address to the existing array so it is cleaned up:

```ts
  const emails = ["accept-a@example.com", "accept-b@example.com", "accept-personal@gmail.com"];
```

Then add the case:

```ts
  // The invitee path for a personal-email account: it has a user row but no
  // workspace — exactly the state the work-email gate leaves it in.
  it("joins a user who belongs to no workspace at all", async () => {
    const { t, token } = await setup();
    const u = await makeUser("accept-personal@gmail.com");
    const before = await db.select().from(tenantMembers).where(eq(tenantMembers.userId, u.id));
    expect(before).toHaveLength(0);

    const res = await acceptInviteForUser(u.id, token);

    expect(res).toEqual({ status: "joined", tenantId: t.id });
  });
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run tests/lib/workspace/session.test.ts tests/lib/workspace/accept-invite.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/workspace/session.ts src/app/invite/\[token\]/accept-actions.ts tests/lib/workspace/session.test.ts tests/lib/workspace/accept-invite.test.ts
git commit -m "feat: route workspace-less users to the work-email page"
```

---

## Task 4: The blocked page

**Files:**
- Create: `src/app/work-email-required/page.tsx`
- Create: `src/app/work-email-required/signout-button.tsx`

**Interfaces:**
- Consumes: `requireSession()`'s redirect target from Task 3; `resolveActiveTenant` and `ACTIVE_TENANT_COOKIE` from `@/lib/workspace/active-tenant`.
- Produces: nothing.

- [ ] **Step 1: Read the sign-in page for layout conventions**

Run: `cat src/app/signin/page.tsx`

Mirror its shell exactly — `min-h-screen flex items-center justify-center p-6`, centered `Logo`, `font-heading` heading, one `Card`. This page must look like a sibling of `/signin`, not a new design.

- [ ] **Step 2: Write the page**

Create `src/app/work-email-required/page.tsx`:

```tsx
import { getServerSession } from "next-auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/workspace/auth";
import { hasValidSession } from "@/lib/workspace/session";
import { ACTIVE_TENANT_COOKIE, resolveActiveTenant } from "@/lib/workspace/active-tenant";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/brand/logo";

/**
 * Shown to a signed-in user who belongs to no workspace — chiefly a personal-email
 * signup, which is not allowed to create one.
 *
 * Uses getServerSession directly: requireSession() redirects HERE when there is no
 * membership, so calling it would loop.
 */
export default async function WorkEmailRequiredPage() {
  const session = await getServerSession(authOptions);
  if (!hasValidSession(session)) redirect("/signin");

  // A user who does have a workspace has no business on this page — most likely a
  // stale bookmark, or they accepted an invite in another tab.
  const store = await cookies();
  const active = await resolveActiveTenant(session.user.id, store.get(ACTIVE_TENANT_COOKIE)?.value);
  if (active) redirect("/");

  const email = session.user.email;

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center gap-5 text-center">
          <Logo />
          <div className="space-y-1.5">
            <h1 className="font-heading text-4xl leading-[1.15] tracking-[0.015em] text-balance">
              Use your work email
            </h1>
            <p className="text-muted-foreground text-sm">
              versional workspaces are created for teams, so we can&apos;t set one up for a personal
              account{email ? ` like ${email}` : ""}.
            </p>
          </div>
        </div>
        <Card>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Sign in again with your company account and we&apos;ll get your workspace ready. If a
              teammate invited you, open their invite link instead — that works with any address.
            </p>
            {/* Sign out first: without clearing the session the provider silently
                re-picks the same personal account and the user loops back here. */}
            <SignOutButton />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

**The sign-out button must be a client component.** Create `src/app/work-email-required/signout-button.tsx`:

```tsx
"use client";

import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";

export function SignOutButton() {
  return (
    <Button className="w-full" onClick={() => signOut({ callbackUrl: "/signin" })}>
      Sign in with your work account
    </Button>
  );
}
```

A plain `<a href="/api/auth/signout?callbackUrl=/signin">` does NOT work, and this was corrected only after the first implementation attempt shipped it. In NextAuth v4 a **GET** to `/api/auth/signout` renders an unstyled confirmation interstitial (`node_modules/next-auth/core/index.js:122`); only the **POST** from that page, carrying a CSRF token, reaches `routes/signout.ts` and actually clears the session (`core/index.js:226`). `signOut()` from `next-auth/react` fetches the CSRF token, POSTs, and then performs a real full-page navigation — one click, and it genuinely signs out. `src/app/(dashboard)/user-menu.tsx:39` is the existing precedent in this codebase.

Elsewhere in this plan, Button-as-link uses `render={<a … />}` (see the GitHub connect button in Task 9), not `asChild` — but that idiom is wrong for auth routes specifically.

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add src/app/work-email-required/page.tsx
git commit -m "feat: add the work-email-required page"
```

---

## Task 5: Onboarding step storage and the pure guard

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/<generated>.sql` (via `npm run db:generate`)
- Create: `src/lib/workspace/onboarding-step.ts`
- Modify: `src/lib/workspace/onboarding.ts`
- Test: `tests/lib/workspace/onboarding-step.test.ts`, `tests/lib/workspace/onboarding.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, used by Tasks 7–10:
  - `type OnboardingStep = 1 | 2 | 3 | 4`
  - `ONBOARDING_STEP_PATHS: Record<OnboardingStep, string>`
  - `clampStep(value: number): OnboardingStep`
  - `resolveOnboardingRedirect(args: { completed: boolean; storedStep: number; requestedStep: OnboardingStep }): string | null`
  - `getOnboardingState(tenantId, db?): Promise<{ completed: boolean; storedStep: number }>`
  - `advanceOnboardingStep(tenantId, step: OnboardingStep, db?): Promise<void>`

- [ ] **Step 1: Add the column to the schema**

In `src/db/schema.ts`, add to the `tenants` table, after `onboardingCompletedAt`:

```ts
  // Furthest wizard step reached (1–4). An explicit column because steps 2 and 3
  // are skippable — their DB artifacts cannot distinguish "skipped" from "not
  // reached" — and `name` is auto-derived at signup, so it is never empty.
  onboardingStep: integer("onboarding_step").notNull().default(1),
```

Add `integer` to the `drizzle-orm/pg-core` import list at the top of the file if it is not already there.

- [ ] **Step 2: Generate and apply the migration**

```bash
npm run db:generate
npm run db:migrate
npm run db:migrate:test
```

Expected: a new `src/db/migrations/00XX_*.sql` containing `ADD COLUMN "onboarding_step" integer DEFAULT 1 NOT NULL`. Existing tenants get `1`; those already past onboarding have `onboarding_completed_at` set, which is checked first and short-circuits to the dashboard, so they are unaffected.

- [ ] **Step 3: Write the failing test for the pure guard**

Create `tests/lib/workspace/onboarding-step.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  clampStep,
  resolveOnboardingRedirect,
  ONBOARDING_STEP_PATHS,
} from "../../../src/lib/workspace/onboarding-step";

describe("clampStep", () => {
  it("keeps valid steps", () => {
    expect(clampStep(1)).toBe(1);
    expect(clampStep(4)).toBe(4);
  });

  it("clamps out-of-range and non-integer values", () => {
    expect(clampStep(0)).toBe(1);
    expect(clampStep(-3)).toBe(1);
    expect(clampStep(9)).toBe(4);
    expect(clampStep(2.7)).toBe(2);
  });
});

describe("resolveOnboardingRedirect", () => {
  it("sends a finished tenant to the dashboard from any step", () => {
    expect(resolveOnboardingRedirect({ completed: true, storedStep: 1, requestedStep: 3 })).toBe("/atomic-updates");
    expect(resolveOnboardingRedirect({ completed: true, storedStep: 4, requestedStep: 4 })).toBe("/atomic-updates");
  });

  it("renders the requested step when it is the stored one", () => {
    expect(resolveOnboardingRedirect({ completed: false, storedStep: 2, requestedStep: 2 })).toBeNull();
  });

  // Back-navigation must work: the routes are real URLs and the browser Back
  // button is the only way back through the wizard.
  it("renders an earlier step without redirecting", () => {
    expect(resolveOnboardingRedirect({ completed: false, storedStep: 3, requestedStep: 1 })).toBeNull();
  });

  it("blocks jumping ahead of the stored step", () => {
    expect(resolveOnboardingRedirect({ completed: false, storedStep: 1, requestedStep: 4 })).toBe(
      ONBOARDING_STEP_PATHS[1]
    );
    expect(resolveOnboardingRedirect({ completed: false, storedStep: 3, requestedStep: 4 })).toBe(
      ONBOARDING_STEP_PATHS[3]
    );
  });

  it("clamps a corrupt stored step rather than redirecting nowhere", () => {
    expect(resolveOnboardingRedirect({ completed: false, storedStep: 0, requestedStep: 2 })).toBe(
      ONBOARDING_STEP_PATHS[1]
    );
  });

  it("maps every step to its route", () => {
    expect(ONBOARDING_STEP_PATHS).toEqual({
      1: "/onboarding/workspace",
      2: "/onboarding/brand",
      3: "/onboarding/connect",
      4: "/onboarding/schedule",
    });
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run tests/lib/workspace/onboarding-step.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 5: Write the pure module**

Create `src/lib/workspace/onboarding-step.ts`:

```ts
export type OnboardingStep = 1 | 2 | 3 | 4;

export const ONBOARDING_STEP_PATHS: Record<OnboardingStep, string> = {
  1: "/onboarding/workspace",
  2: "/onboarding/brand",
  3: "/onboarding/connect",
  4: "/onboarding/schedule",
};

export const LAST_ONBOARDING_STEP: OnboardingStep = 4;

/** Coerce anything the column could hold into a real step. */
export function clampStep(value: number): OnboardingStep {
  if (!Number.isFinite(value) || value <= 1) return 1;
  if (value >= LAST_ONBOARDING_STEP) return LAST_ONBOARDING_STEP;
  return Math.floor(value) as OnboardingStep;
}

/**
 * Where a request for `requestedStep` should go: a path to redirect to, or null
 * to render the step.
 *
 * Going BACK is allowed (the routes are real URLs and the browser Back button is
 * the only way back through the wizard); jumping AHEAD is not, since a later
 * step's screen assumes the earlier answers exist.
 */
export function resolveOnboardingRedirect({
  completed,
  storedStep,
  requestedStep,
}: {
  completed: boolean;
  storedStep: number;
  requestedStep: OnboardingStep;
}): string | null {
  if (completed) return "/atomic-updates";
  const stored = clampStep(storedStep);
  if (stored < requestedStep) return ONBOARDING_STEP_PATHS[stored];
  return null;
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `npx vitest run tests/lib/workspace/onboarding-step.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the failing test for the DB helpers**

Append to `tests/lib/workspace/onboarding.test.ts`:

```ts
import { getOnboardingState, advanceOnboardingStep } from "../../../src/lib/workspace/onboarding";

describe("onboarding step storage", () => {
  afterEach(async () => {
    await db.delete(tenants).where(eq(tenants.name, "Onboarding Step Tenant"));
  });

  async function newTenant() {
    const [tenant] = await db.insert(tenants).values({ name: "Onboarding Step Tenant" }).returning();
    return tenant.id;
  }

  it("starts a fresh tenant on step 1", async () => {
    const id = await newTenant();
    expect(await getOnboardingState(id)).toEqual({ completed: false, storedStep: 1 });
  });

  it("advances forward", async () => {
    const id = await newTenant();
    await advanceOnboardingStep(id, 3);
    expect((await getOnboardingState(id)).storedStep).toBe(3);
  });

  // Browser Back then re-submitting step 1 must not rewind someone on step 3.
  it("never moves backward", async () => {
    const id = await newTenant();
    await advanceOnboardingStep(id, 3);
    await advanceOnboardingStep(id, 2);
    expect((await getOnboardingState(id)).storedStep).toBe(3);
  });

  it("reports completion", async () => {
    const id = await newTenant();
    await markOnboardingComplete(id);
    expect((await getOnboardingState(id)).completed).toBe(true);
  });
});
```

Add `describe`-scope imports as needed — the file already imports `describe, it, expect, afterEach`, `eq`, `db`, `tenants`, and `markOnboardingComplete`.

- [ ] **Step 8: Run it to verify it fails**

Run: `npx vitest run tests/lib/workspace/onboarding.test.ts`
Expected: FAIL — `getOnboardingState` is not exported.

- [ ] **Step 9: Add the DB helpers**

Append to `src/lib/workspace/onboarding.ts` (add `sql` to the `drizzle-orm` import):

```ts
export async function getOnboardingState(
  tenantId: string,
  database: typeof defaultDb = defaultDb
): Promise<{ completed: boolean; storedStep: number }> {
  const [tenant] = await database
    .select({ onboardingCompletedAt: tenants.onboardingCompletedAt, onboardingStep: tenants.onboardingStep })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return {
    completed: Boolean(tenant?.onboardingCompletedAt),
    storedStep: tenant?.onboardingStep ?? 1,
  };
}

/**
 * Move the tenant's progress forward. Monotonic: GREATEST is evaluated in SQL, so
 * re-submitting an earlier step (browser Back, then Save) cannot rewind someone
 * already further along, and a form submit racing an OAuth return cannot lose an
 * update the way read-then-write would.
 */
export async function advanceOnboardingStep(
  tenantId: string,
  step: OnboardingStep,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  await database
    .update(tenants)
    .set({ onboardingStep: sql`GREATEST(${tenants.onboardingStep}, ${step})` })
    .where(eq(tenants.id, tenantId));
}
```

Import the type at the top: `import type { OnboardingStep } from "./onboarding-step";`

- [ ] **Step 10: Run tests, typecheck**

Run: `npx vitest run tests/lib/workspace/onboarding.test.ts tests/lib/workspace/onboarding-step.test.ts && npm run typecheck`
Expected: PASS; clean.

- [ ] **Step 11: Commit**

```bash
git add src/db/schema.ts src/db/migrations src/lib/workspace/onboarding-step.ts src/lib/workspace/onboarding.ts tests/lib/workspace/onboarding-step.test.ts tests/lib/workspace/onboarding.test.ts
git commit -m "feat: track the furthest onboarding step reached"
```

---

## Task 6: Notion OAuth can return to onboarding

**Files:**
- Modify: `src/app/api/notion/connect/route.ts`
- Modify: `src/app/api/notion/callback/route.ts`
- Test: `tests/app/api/notion/callback/route.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `/api/notion/connect?returnTo=onboarding` lands the user on `/onboarding/connect?notion_connect=…`. Task 9's Notion button uses this URL.

Background: the OAuth state format already carries a `returnTo` segment
(`buildOAuthState(tenantId, returnTo, nonce)` in `src/lib/integrations/oauth-state.ts`) — the connect route just hardcodes `"integrations"` and the callback ignores it. No new cookie or state format is needed.

- [ ] **Step 1: Write the failing tests**

Add to `tests/app/api/notion/callback/route.test.ts`:

```ts
  it("returns the user to the onboarding connect step when state says so", async () => {
    const nonce = "abc123def456";
    const res = await GET(
      request({ code: "the-code", state: `${currentTenantId}|onboarding|${nonce}` }, nonce) as never
    );
    expect(res.headers.get("location")).toContain("/onboarding/connect");
    expect(res.headers.get("location")).toContain("notion_connect=success");
  });

  it("returns errors to onboarding too when that is where the flow started", async () => {
    const res = await GET(
      request({ code: "c", state: `someone-else|onboarding|nonce` }, "nonce") as never
    );
    expect(res.headers.get("location")).toContain("/onboarding/connect");
    expect(res.headers.get("location")).toContain("notion_connect=error");
  });

  // Anything unrecognised must fall back to integrations — an attacker-controlled
  // state segment must not become an open redirect.
  it("falls back to integrations for an unknown returnTo", async () => {
    const nonce = "abc123def456";
    const res = await GET(
      request({ code: "the-code", state: `${currentTenantId}|https://evil.dev|${nonce}` }, nonce) as never
    );
    expect(res.headers.get("location")).toContain("/integrations");
    expect(res.headers.get("location")).not.toContain("evil.dev");
  });
```

The existing tests already assert `/integrations` for `…|integrations|…` state — they must keep passing unchanged.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/app/api/notion/callback/route.test.ts`
Expected: the two onboarding cases FAIL (location is `/integrations`); the fallback case passes incidentally.

- [ ] **Step 3: Honour `returnTo` in the callback**

In `src/app/api/notion/callback/route.ts`, after `const parsed = parseOAuthState(...)`, add:

```ts
  // Resolve where to send the user once the flow ends. Allowlisted rather than
  // used verbatim: `state` round-trips through Notion, so treating it as a path
  // would be an open redirect.
  const returnPath = parsed.returnTo === "onboarding" ? "/onboarding/connect" : "/integrations";
```

Then replace all three redirect targets:

```ts
    return clearStateCookie(NextResponse.redirect(new URL(`${returnPath}?notion_connect=error`, request.url)));
```

(the two error exits), and:

```ts
    return clearStateCookie(NextResponse.redirect(new URL(`${returnPath}?notion_connect=success`, request.url)));
```

(the success exit).

- [ ] **Step 4: Accept `returnTo` on the connect route**

Replace `src/app/api/notion/connect/route.ts` in full:

```ts
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/workspace/session";
import { buildAuthorizeUrl } from "@/lib/integrations/notion/oauth";
import { newStateNonce, buildOAuthState, OAUTH_STATE_COOKIE_OPTS } from "@/lib/integrations/oauth-state";

// Mirrors /api/github/connect. Defaults to integrations so existing callers,
// which pass nothing, are unaffected.
const ALLOWED_RETURN_TO = new Set(["integrations", "onboarding"]);

export async function GET(request: NextRequest) {
  const session = await requireSession();
  const requested = new URL(request.url).searchParams.get("returnTo") ?? "integrations";
  const returnTo = ALLOWED_RETURN_TO.has(requested) ? requested : "integrations";
  // state carries the tenant id (verified in the callback against the session),
  // where to return the user, and a random CSRF nonce that is also stored in an
  // httpOnly cookie so the callback can prove the redirect belongs to this browser.
  const nonce = newStateNonce();
  const state = buildOAuthState(session.user.tenantId, returnTo, nonce);
  const response = NextResponse.redirect(buildAuthorizeUrl(state));
  response.cookies.set("notion_oauth_state", nonce, OAUTH_STATE_COOKIE_OPTS);
  return response;
}
```

Note the signature change from `GET()` to `GET(request: NextRequest)`.

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/app/api/notion/callback/route.test.ts && npm run typecheck`
Expected: PASS including the pre-existing `/integrations` cases; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/notion/connect/route.ts src/app/api/notion/callback/route.ts tests/app/api/notion/callback/route.test.ts
git commit -m "feat: let the notion oauth flow return to onboarding"
```

---

## Task 7: Wizard shell and step 1 (workspace name)

**Files:**
- Create: `src/app/onboarding/guard.ts`
- Create: `src/app/onboarding/layout.tsx`
- Create: `src/app/onboarding/steps.tsx`
- Replace: `src/app/onboarding/page.tsx`
- Create: `src/app/onboarding/workspace/page.tsx`
- Modify: `src/app/onboarding/actions.ts`

**Interfaces:**
- Consumes: `getOnboardingState`, `advanceOnboardingStep`, `resolveOnboardingRedirect`, `ONBOARDING_STEP_PATHS`, `clampStep`, `OnboardingStep` from Task 5.
- Produces, used by Tasks 8–10:
  - `guardOnboardingStep(step: OnboardingStep): Promise<Session>` from `src/app/onboarding/guard.ts`
  - `<StepHeader step={n} title="…" description="…" />` from `src/app/onboarding/steps.tsx`

- [ ] **Step 1: Read the Next.js routing docs**

Run: `ls node_modules/next/dist/docs/` and read the App Router routing/layout guide. Confirm the current signatures for `layout.tsx`, `page.tsx`, `searchParams`, and `redirect` before writing. Do not assume from memory.

- [ ] **Step 2: Write the guard**

Create `src/app/onboarding/guard.ts`:

```ts
import { redirect } from "next/navigation";
import type { Session } from "next-auth";
import { requireSession } from "@/lib/workspace/session";
import { getOnboardingState } from "@/lib/workspace/onboarding";
import { resolveOnboardingRedirect, type OnboardingStep } from "@/lib/workspace/onboarding-step";

/**
 * Every wizard step page starts with this. Sends finished tenants to the
 * dashboard and anyone who jumped ahead of their stored progress back to the
 * step they are actually on.
 */
export async function guardOnboardingStep(step: OnboardingStep): Promise<Session> {
  const session = await requireSession();
  const { completed, storedStep } = await getOnboardingState(session.user.tenantId);
  const target = resolveOnboardingRedirect({ completed, storedStep, requestedStep: step });
  if (target) redirect(target);
  return session;
}
```

- [ ] **Step 3: Write the shared step header**

Create `src/app/onboarding/steps.tsx`:

```tsx
import { LAST_ONBOARDING_STEP, type OnboardingStep } from "@/lib/workspace/onboarding-step";
import { cn } from "@/lib/utils";

export function StepHeader({
  step,
  title,
  description,
}: {
  step: OnboardingStep;
  title: string;
  description?: string;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2" aria-hidden>
        {Array.from({ length: LAST_ONBOARDING_STEP }, (_, i) => (
          <span
            key={i}
            className={cn("h-1.5 flex-1 rounded-full", i < step ? "bg-primary" : "bg-muted")}
          />
        ))}
      </div>
      <div className="space-y-1.5">
        <p className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
          Step {step} of {LAST_ONBOARDING_STEP}
        </p>
        <h1 className="font-heading text-3xl leading-[1.15] tracking-[0.015em]">{title}</h1>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
    </div>
  );
}
```

`cn` is exported from `src/lib/utils.ts:5`.

- [ ] **Step 4: Write the layout**

Create `src/app/onboarding/layout.tsx`:

```tsx
import { Logo } from "@/components/brand/logo";

export default function OnboardingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen p-6 py-16">
      <div className="mx-auto w-full max-w-lg space-y-8">
        <Logo />
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Replace the entry page with a redirect**

Replace `src/app/onboarding/page.tsx` in full. Its previous contents are being split across Tasks 7–10; delete them.

```tsx
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/workspace/session";
import { getOnboardingState } from "@/lib/workspace/onboarding";
import { ONBOARDING_STEP_PATHS, clampStep } from "@/lib/workspace/onboarding-step";

/**
 * Entry point and OAuth return target. GitHub's connect/setup routes resolve
 * returnTo=onboarding to this path, so it must always forward somewhere real.
 */
export default async function OnboardingPage() {
  const session = await requireSession();
  const { completed, storedStep } = await getOnboardingState(session.user.tenantId);
  if (completed) redirect("/atomic-updates");
  redirect(ONBOARDING_STEP_PATHS[clampStep(storedStep)]);
}
```

- [ ] **Step 6: Write step 1**

Create `src/app/onboarding/workspace/page.tsx`:

```tsx
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tenants } from "@/db/schema";
import { guardOnboardingStep } from "../guard";
import { StepHeader } from "../steps";
import { saveWorkspaceName } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function WorkspaceStepPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await guardOnboardingStep(1);
  const { error } = await searchParams;
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, session.user.tenantId)).limit(1);

  return (
    <div className="space-y-8">
      <StepHeader
        step={1}
        title="Name your workspace"
        description="This is how your team will see it. You can change it later in Settings."
      />
      <form action={saveWorkspaceName} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Workspace name</Label>
          <Input id="name" name="name" defaultValue={tenant?.name ?? ""} autoFocus required />
          {error === "empty" && <p className="text-destructive text-sm">Give your workspace a name to continue.</p>}
        </div>
        <Button type="submit" className="w-full">
          Continue
        </Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 7: Rewrite `saveWorkspaceName`**

In `src/app/onboarding/actions.ts`, replace `saveWorkspaceName` and add the new imports (`advanceOnboardingStep` from `@/lib/workspace/onboarding`):

```ts
export async function saveWorkspaceName(formData: FormData) {
  const session = await requireSession();
  const name = (formData.get("name") as string)?.trim();
  // Previously this returned silently on an empty name, leaving the user staring
  // at an unchanged form with no feedback.
  if (!name) redirect("/onboarding/workspace?error=empty");

  await db.update(tenants).set({ name }).where(eq(tenants.id, session.user.tenantId));
  await advanceOnboardingStep(session.user.tenantId, 2);
  redirect("/onboarding/brand");
}
```

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: errors ONLY from the not-yet-created `/onboarding/brand`, `/connect`, `/schedule` routes being referenced — those are string paths, so there should in fact be no errors. Any real error must be fixed now.

- [ ] **Step 9: Commit**

```bash
git add src/app/onboarding
git commit -m "feat: add the onboarding wizard shell and workspace-name step"
```

---

## Task 8: Step 2 (brand style)

**Files:**
- Create: `src/app/onboarding/brand/page.tsx`
- Modify: `src/app/onboarding/actions.ts`

**Interfaces:**
- Consumes: `guardOnboardingStep`, `StepHeader` from Task 7; `importBrandStyleForTenant` from `@/lib/workspace/brand-import`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the page**

Create `src/app/onboarding/brand/page.tsx`:

```tsx
import { guardOnboardingStep } from "../guard";
import { StepHeader } from "../steps";
import { importBrandStyle, skipBrandStep } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default async function BrandStepPage({
  searchParams,
}: {
  searchParams: Promise<{ brandImport?: string }>;
}) {
  await guardOnboardingStep(2);
  const { brandImport } = await searchParams;

  return (
    <div className="space-y-8">
      <StepHeader
        step={2}
        title="Import your brand style"
        description="Paste your existing changelog or “what’s new” page and we’ll learn how you write. Refine it anytime in Settings."
      />
      <form action={importBrandStyle} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="updatesPageUrl">Updates page URL</Label>
          <Input
            id="updatesPageUrl"
            name="updatesPageUrl"
            type="url"
            placeholder="https://yourproduct.com/changelog"
            autoFocus
            required
          />
          {brandImport === "failed" && (
            <p className="text-muted-foreground text-sm">
              We couldn&apos;t read that page. Try another URL, or skip and set your brand style in Settings.
            </p>
          )}
        </div>
        <Button type="submit" className="w-full">
          Import and continue
        </Button>
      </form>
      <form action={skipBrandStep}>
        <Button type="submit" variant="ghost" className="text-muted-foreground w-full">
          Skip this step
        </Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Rewrite `importBrandStyle` and add `skipBrandStep`**

In `src/app/onboarding/actions.ts`, replace `importBrandStyle` and append `skipBrandStep`:

```ts
export async function importBrandStyle(formData: FormData) {
  const session = await requireSession();
  const url = (formData.get("updatesPageUrl") as string)?.trim();
  if (!url) redirect("/onboarding/brand");

  const result = await importBrandStyleForTenant(session.user.tenantId, url);
  // A failed scrape keeps the user on step 2 so they can try another URL or skip;
  // only a success advances.
  if (!result.ok) redirect("/onboarding/brand?brandImport=failed");

  await advanceOnboardingStep(session.user.tenantId, 3);
  redirect("/onboarding/connect");
}

export async function skipBrandStep() {
  const session = await requireSession();
  await advanceOnboardingStep(session.user.tenantId, 3);
  redirect("/onboarding/connect");
}
```

The old `isOnboardingComplete` guard at the top of `importBrandStyle` is dropped — `guardOnboardingStep(2)` on the page already covers it, and the action's own `requireSession()` still enforces auth.

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: clean. Remove the now-unused `isOnboardingComplete` import from `actions.ts` if lint flags it.

- [ ] **Step 4: Commit**

```bash
git add src/app/onboarding
git commit -m "feat: add the brand-style onboarding step"
```

---

## Task 9: Step 3 (connect GitHub / Notion)

**Files:**
- Create: `src/app/onboarding/connect/page.tsx`
- Modify: `src/app/onboarding/actions.ts`

**Interfaces:**
- Consumes: `guardOnboardingStep`, `StepHeader` from Task 7; `/api/notion/connect?returnTo=onboarding` from Task 6; `RepoRow` from `@/app/(dashboard)/integrations/repo-row`; `NotionDatabaseForm` from `@/app/(dashboard)/integrations/notion-database-form`; `fetchNotionDatabases` from `@/app/(dashboard)/integrations/notion-actions`.
- Produces: `finishConnectStep()` server action.

This is the largest screen. Both sub-components already exist and are reused as-is — do not rebuild them. The current onboarding page already imports `RepoRow` across the route-group boundary, so that pattern is established.

- [ ] **Step 1: Write the page**

Create `src/app/onboarding/connect/page.tsx`:

```tsx
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { repos, tenants, notionConnections } from "@/db/schema";
import { guardOnboardingStep } from "../guard";
import { StepHeader } from "../steps";
import { addOnboardingRepos, finishConnectStep } from "../actions";
import { listAccessibleRepos, listRepoBranches } from "@/lib/integrations/github/github";
import { RepoRow } from "@/app/(dashboard)/integrations/repo-row";
import { NotionDatabaseForm } from "@/app/(dashboard)/integrations/notion-database-form";
import { fetchNotionDatabases } from "@/app/(dashboard)/integrations/notion-actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function ConnectStepPage() {
  const session = await guardOnboardingStep(3);
  const tenantId = session.user.tenantId;

  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const [notion] = await db.select().from(notionConnections).where(eq(notionConnections.tenantId, tenantId)).limit(1);
  const tenantRepos = await db.select().from(repos).where(eq(repos.tenantId, tenantId));

  const githubConnected = Boolean(tenant?.githubInstallationId);
  const connected = githubConnected || Boolean(notion);

  const accessibleRepos = tenant?.githubInstallationId
    ? await listAccessibleRepos(tenant.githubInstallationId)
    : [];
  const watchedFullNames = new Set(tenantRepos.map((r) => r.githubRepoFullName));
  const branchesByFullName = new Map<string, string[]>();
  if (tenant?.githubInstallationId) {
    for (const r of accessibleRepos) {
      // Guard each repo's fetch: a transient GitHub error or a missing
      // branch-list permission on ONE repo must not crash the whole step. The
      // Combobox degrades to an empty list and the row still submits its
      // default branch.
      try {
        branchesByFullName.set(r.fullName, await listRepoBranches(tenant.githubInstallationId, r.fullName));
      } catch {
        branchesByFullName.set(r.fullName, []);
      }
    }
  }

  // Notion is only useful once a database is picked, so surface the picker as
  // soon as the connection exists — mirroring the repo sub-step.
  const notionDatabases = notion ? await fetchNotionDatabases().catch(() => []) : [];

  return (
    <div className="space-y-8">
      <StepHeader
        step={3}
        title="Connect your work"
        description="We watch these for shipped changes. Connect either one — or both."
      />

      <Card>
        <CardHeader>
          <CardTitle>GitHub</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!githubConnected ? (
            <Button variant="outline" render={<a href="/api/github/connect?returnTo=onboarding" />}>
              Connect GitHub
            </Button>
          ) : tenantRepos.length > 0 ? (
            <p className="text-sm">
              Watching {tenantRepos.length} {tenantRepos.length === 1 ? "repo" : "repos"}.
            </p>
          ) : (
            <form action={addOnboardingRepos} className="space-y-3">
              <p className="text-muted-foreground text-sm">Pick the repos to watch.</p>
              <input type="hidden" name="repoCount" value={accessibleRepos.length} />
              {accessibleRepos.map((repo, i) => (
                <RepoRow
                  key={repo.fullName}
                  index={i}
                  fullName={repo.fullName}
                  branches={branchesByFullName.get(repo.fullName) ?? []}
                  defaultBranch={repo.defaultBranch}
                  defaultChecked={watchedFullNames.has(repo.fullName)}
                />
              ))}
              {accessibleRepos.length === 0 && (
                <p className="text-muted-foreground text-sm">No accessible repos found.</p>
              )}
              <Button type="submit" variant="outline">
                Add selected repos
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notion</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!notion ? (
            <Button variant="outline" render={<a href="/api/notion/connect?returnTo=onboarding" />}>
              Connect Notion
            </Button>
          ) : notion.databaseId ? (
            <p className="text-sm">Using {notion.databaseName ?? "your selected database"}.</p>
          ) : (
            <NotionDatabaseForm databases={notionDatabases} currentDatabaseId={notion.databaseId} />
          )}
        </CardContent>
      </Card>

      {/* One control, never two: with nothing connected, "Continue" and "Skip"
          would do exactly the same thing — so the same action backs both, and
          only the label and emphasis change. */}
      <form action={finishConnectStep}>
        <Button
          type="submit"
          variant={connected ? "default" : "ghost"}
          className={connected ? "w-full" : "text-muted-foreground w-full"}
        >
          {connected ? "Continue" : "Skip this step"}
        </Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Update the actions**

In `src/app/onboarding/actions.ts`, change the redirect at the end of `addOnboardingRepos` and append one action:

```ts
  redirect("/onboarding/connect");
}

/**
 * Leaves step 3, whether the user connected something or skipped. Both cases do
 * the same thing — the step's only stored outcome is the connection itself, and
 * that is written by the OAuth callbacks, not here.
 */
export async function finishConnectStep() {
  const session = await requireSession();
  await advanceOnboardingStep(session.user.tenantId, 4);
  redirect("/onboarding/schedule");
}
```

`addOnboardingRepos` keeps its existing branch-validation logic unchanged, and deliberately does NOT advance the step — adding repos leaves the user on step 3.

- [ ] **Step 3: Confirm the toaster covers the onboarding route**

`NotionDatabaseForm` reports success/failure via `toast` from `sonner`, and onboarding sits outside the `(dashboard)` layout. `<Toaster />` is mounted in the **root** layout (`src/app/layout.tsx:48`), so this works — confirm it is still there rather than assuming:

Run: `grep -n "Toaster" src/app/layout.tsx`
Expected: a match. If it has moved into `(dashboard)/layout.tsx`, move it back to the root layout, or the Notion sub-step saves with no visible feedback.

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/onboarding src/app/layout.tsx
git commit -m "feat: add the connect-integrations onboarding step"
```

---

## Task 10: Step 4 (schedule) and removal of the old flow

**Files:**
- Create: `src/app/onboarding/schedule/page.tsx`
- Modify: `src/app/onboarding/actions.ts`

**Interfaces:**
- Consumes: `guardOnboardingStep`, `StepHeader` from Task 7.
- Produces: completing this step is what calls `markOnboardingComplete`.

- [ ] **Step 1: Write the page**

Create `src/app/onboarding/schedule/page.tsx`:

```tsx
import { guardOnboardingStep } from "../guard";
import { StepHeader } from "../steps";
import { saveOnboardingSchedule } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default async function ScheduleStepPage() {
  await guardOnboardingStep(4);

  return (
    <div className="space-y-8">
      <StepHeader
        step={4}
        title="Choose your rhythm"
        description="How often should we draft an update? Change it anytime in Settings."
      />
      <form action={saveOnboardingSchedule} className="space-y-6">
        <div className="space-y-2">
          <Label>Cadence</Label>
          <Select name="cadence" defaultValue="weekly">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">Daily</SelectItem>
              <SelectItem value="weekly">Weekly</SelectItem>
              <SelectItem value="biweekly">Every 2 weeks</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="none">No fixed cadence (threshold only)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="threshold">Or after at least this many changes</Label>
          <Input id="threshold" type="number" name="threshold" min={1} defaultValue={5} />
        </div>
        <Button type="submit" className="w-full">
          Finish setup
        </Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 2: Delete `skipOnboarding`**

Remove the `skipOnboarding` action from `src/app/onboarding/actions.ts` entirely. Nothing references it once the old page is gone (verify with `grep -rn "skipOnboarding" src`). Per-step skips replace it; step 4's "Finish setup" is the exit.

`saveOnboardingSchedule` is unchanged — it already writes the schedule config, calls `markOnboardingComplete`, and redirects to `/atomic-updates`.

- [ ] **Step 3: Confirm no dangling references to the old flow**

Run:

```bash
grep -rn "skipOnboarding" src tests
grep -rn "from \"./actions\"\|from \"../actions\"" src/app/onboarding
```

Expected: no `skipOnboarding` hits; every action import resolves to something that still exists.

- [ ] **Step 4: Typecheck, lint, full test suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/onboarding
git commit -m "feat: add the schedule step and drop the single-page onboarding"
```

---

## Task 11: End-to-end verification

**Files:** none — this task only runs and reports.

**Interfaces:**
- Consumes: everything above.
- Produces: a verified branch.

- [ ] **Step 1: Full gate**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all three clean. Do not proceed past a failure — fix it.

- [ ] **Step 2: Confirm migrations apply to a fresh database**

Run: `npm run db:migrate:test`
Expected: no pending migrations (already applied in Task 5); no errors.

- [ ] **Step 3: Walk the wizard manually**

Start the dev server and sign in with a corporate-domain account on a fresh workspace. Verify in order:

1. `/onboarding` redirects to `/onboarding/workspace`.
2. Submitting an empty name shows the inline error, does not advance.
3. Saving a name lands on `/onboarding/brand`.
4. Manually visiting `/onboarding/schedule` bounces back to `/onboarding/brand`.
5. Browser Back to `/onboarding/workspace` renders, and re-saving does NOT rewind progress.
6. "Skip this step" on brand lands on `/onboarding/connect`.
7. With nothing connected, the footer shows "Skip this step" — not "Continue".
8. Connect GitHub; the OAuth return lands back on `/onboarding/connect` and the repo picker appears.
9. After adding repos, the footer shows "Continue".
10. "Finish setup" on step 4 lands on `/atomic-updates`, and revisiting `/onboarding` now redirects there too.

**Note:** per the `preview-behind-oauth-wall` constraint, the dev preview sits behind Google/GitHub login, so this walkthrough may need to be done by the user rather than self-verified. If it cannot be run, say so explicitly rather than reporting it as passed.

- [ ] **Step 4: Verify the work-email gate**

With `ALLOWED_PERSONAL_EMAILS` unset, sign in using a gmail.com account. Expect `/work-email-required`, with no `tenants` row created for it:

```sql
select * from tenants order by created_at desc limit 3;
```

Then click "Sign in with your work account" and confirm it signs out and returns to `/signin` in **one click**, with no NextAuth confirmation interstitial in between, and does not loop back.

- [ ] **Step 5: Verify the invite bypass**

From the corporate workspace, generate an invite link, open it in a private window, sign in with the same gmail.com account, and accept. Expect to land in the workspace — not on `/work-email-required`.

- [ ] **Step 6: Final commit if anything was fixed**

```bash
git add -A
git commit -m "fix: address issues found during onboarding verification"
```

---

## Self-Review Notes

Spec coverage checked section by section:

| Spec section | Task |
|---|---|
| `email-domain.ts` + curated list + env allowlist | 1 |
| `getOrCreateUserFromOAuth` no-tenant path, check-after-membership ordering | 2 |
| Session/JWT types, `?? ""` coercion | 2 |
| `requireSession()` redirect target | 3 |
| `requireUser()` | 3 |
| `acceptInvite` swap | 3 |
| `/work-email-required` page | 4 |
| `tenants.onboarding_step` migration | 5 |
| `resolveOnboardingRedirect` guard | 5 |
| Monotonic `advanceOnboardingStep` | 5 |
| Notion `returnTo` (connect + callback + allowlist) | 6 |
| Route-per-step, layout, `/onboarding` redirect | 7 |
| Steps 1–4 | 7, 8, 9, 10 |
| Repo sub-step, Notion database sub-step | 9 |
| Single footer control on step 3 | 9 |
| `skipOnboarding` removal | 10 |
| Test list (email-domain, onboarding-step, tenant-bootstrap, onboarding, accept-invite) | 1, 2, 3, 5 |

Two items added beyond the spec:

- **Task 9, Step 3** confirms `<Toaster />` is mounted in the root layout. `NotionDatabaseForm` was written for the dashboard; onboarding sits outside that layout, so reusing it blind would risk a Notion sub-step that saves with no visible feedback. (Verified during planning: it is at `src/app/layout.tsx:48`, so this is a guard against regression, not a fix.)
- **Task 7, Step 7** makes `saveWorkspaceName` redirect with an inline error on an empty name. The current action returns silently, leaving the user staring at an unchanged form. The spec called the name "required" without saying what enforcement looks like.

Conventions verified against the real files while planning, rather than assumed:

- `tests/lib/workspace/session.test.ts` uses the **real** `next/navigation` redirect and asserts on the thrown error's `digest` — the plan follows that instead of introducing a redirect mock.
- `tests/lib/workspace/accept-invite.test.ts` has `setup()` / `makeUser()` helpers and an `emails` array driving cleanup — the new case reuses them.
- The OAuth state format already carries a `returnTo` segment, so Task 6 changes two call sites rather than the state format.
- Button-as-link uses `render={<a … />}`, not `asChild`.
