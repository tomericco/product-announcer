import { describe, it, expect, afterEach, vi } from "vitest";

let currentTenantId = "";
let currentUserId: string | null = "user-1";

// requireSession() returns a NextAuth Session (tenantId lives under `user`,
// per src/types/next-auth.d.ts) — mirror that shape rather than a flat one,
// so the mock matches what the real module actually returns. Pattern copied
// from tests/app/atomic-updates-actions.test.ts.
vi.mock("../../src/lib/workspace/session", () => ({
  requireSession: vi.fn(async () => ({ user: { tenantId: currentTenantId, id: currentUserId } })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// The reassign action only orchestrates: derive tenant/user from the (mocked)
// session, parse the target off formData, call reassignChangeEvent, and
// revalidate. The core's own tenant re-validation and transactional behavior
// is covered by tests/lib/change-events/reassign.test.ts — mocking it here
// keeps this test from touching Postgres for the reassign path and, per the
// task's hard constraint, never reaches the live Anthropic API.
vi.mock("../../src/lib/change-events/reassign", () => ({
  reassignChangeEvent: vi.fn(async () => ({ ok: true })),
}));

import { reassign } from "../../src/app/(dashboard)/change-events/actions";
import { reassignChangeEvent } from "../../src/lib/change-events/reassign";
import { revalidatePath } from "next/cache";

describe("reassign", () => {
  const REASSIGN_TENANT = "reassign-session-tenant";
  const REASSIGN_USER = "reassign-session-user";

  afterEach(() => {
    vi.mocked(reassignChangeEvent).mockClear();
    vi.mocked(revalidatePath).mockClear();
    currentTenantId = "";
    currentUserId = "user-1";
  });

  it("calls reassignChangeEvent with the session's tenantId/userId and the parsed 'existing' target, then revalidates", async () => {
    currentTenantId = REASSIGN_TENANT;
    currentUserId = REASSIGN_USER;

    const formData = new FormData();
    formData.set("eventId", "event-1");
    formData.set("targetKind", "existing");
    formData.set("atomicUpdateId", "au-1");

    const result = await reassign(formData);

    expect(reassignChangeEvent).toHaveBeenCalledWith({
      tenantId: REASSIGN_TENANT,
      userId: REASSIGN_USER,
      eventId: "event-1",
      target: { kind: "existing", atomicUpdateId: "au-1" },
      confirmEmptyDeletion: false,
    });
    expect(result).toEqual({ ok: true });
    expect(revalidatePath).toHaveBeenCalledWith("/change-events");
  });

  it("parses a 'detach' target with no atomicUpdateId", async () => {
    currentTenantId = REASSIGN_TENANT;
    currentUserId = REASSIGN_USER;

    const formData = new FormData();
    formData.set("eventId", "event-2");
    formData.set("targetKind", "detach");

    await reassign(formData);

    expect(reassignChangeEvent).toHaveBeenCalledWith({
      tenantId: REASSIGN_TENANT,
      userId: REASSIGN_USER,
      eventId: "event-2",
      target: { kind: "detach" },
      confirmEmptyDeletion: false,
    });
  });

  it("parses a 'new' target (split to new atomic update)", async () => {
    currentTenantId = REASSIGN_TENANT;
    currentUserId = REASSIGN_USER;

    const formData = new FormData();
    formData.set("eventId", "event-3");
    formData.set("targetKind", "new");

    await reassign(formData);

    expect(reassignChangeEvent).toHaveBeenCalledWith({
      tenantId: REASSIGN_TENANT,
      userId: REASSIGN_USER,
      eventId: "event-3",
      target: { kind: "new" },
      confirmEmptyDeletion: false,
    });
  });

  it("derives tenantId/userId from the session, ignoring any tenantId/userId fields present on formData", async () => {
    currentTenantId = REASSIGN_TENANT;
    currentUserId = REASSIGN_USER;

    const formData = new FormData();
    formData.set("eventId", "event-4");
    formData.set("targetKind", "detach");
    // A malicious or stale client could stuff these in; the action must never
    // read them.
    formData.set("tenantId", "some-other-tenant");
    formData.set("userId", "some-other-user");

    await reassign(formData);

    expect(reassignChangeEvent).toHaveBeenCalledWith({
      tenantId: REASSIGN_TENANT,
      userId: REASSIGN_USER,
      eventId: "event-4",
      target: { kind: "detach" },
      confirmEmptyDeletion: false,
    });
  });

  it("returns {ok:false, reason} from the core without throwing, and still revalidates", async () => {
    currentTenantId = REASSIGN_TENANT;
    currentUserId = REASSIGN_USER;
    vi.mocked(reassignChangeEvent).mockResolvedValueOnce({
      ok: false,
      reason: "Cannot move an event out of a published atomic update.",
    });

    const formData = new FormData();
    formData.set("eventId", "event-5");
    formData.set("targetKind", "existing");
    formData.set("atomicUpdateId", "au-2");

    const result = await reassign(formData);

    expect(result).toEqual({
      ok: false,
      reason: "Cannot move an event out of a published atomic update.",
    });
  });
});
