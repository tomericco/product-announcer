export const MAX_LENGTH = 200;

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_LENGTH)
    .replace(/-$/, "");
  // Webflow requires a non-empty slug; a title of pure punctuation would
  // otherwise produce a validation error we can't act on.
  return slug || "update";
}

export function withSuffix(slug: string, attempt: number): string {
  if (attempt === 0) {
    return slug;
  }

  const suffix = `-${attempt + 1}`;
  const maxBaseLength = MAX_LENGTH - suffix.length;

  // Truncate the base slug to make room for the suffix
  const truncatedBase = slug.slice(0, maxBaseLength);

  // Strip trailing hyphens to avoid double hyphens when appending the suffix
  const cleanBase = truncatedBase.replace(/-+$/, "");

  return `${cleanBase}${suffix}`;
}
