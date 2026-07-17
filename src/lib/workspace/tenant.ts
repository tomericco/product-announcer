export function deriveDefaultTenantName(email: string): string {
  const domain = email.split("@")[1] ?? "";
  const label = domain.split(".")[0] ?? "My";
  const capitalized = label.charAt(0).toUpperCase() + label.slice(1);
  return `${capitalized}'s Workspace`;
}
