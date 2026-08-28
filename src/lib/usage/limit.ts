/**
 * The monthly credit limit for a tenant, or null when there is none.
 *
 * THE LIMIT SEAM. There is no plan/package model yet, so every tenant is
 * unlimited and this returns null unconditionally — the usage tab renders a
 * plain month-to-date total for null and a progress-against-limit view for a
 * number (see `usage-headline.tsx`), so wiring a real source here is the only
 * change the UI needs when packages land. Enforcement (blocking calls at the
 * limit) is explicitly out of scope until then — see the usage-tab spec.
 */
export async function getMonthlyCreditLimit(_tenantId: string): Promise<number | null> {
  return null;
}
