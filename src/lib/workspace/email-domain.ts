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
