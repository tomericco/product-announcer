// Derives up-to-2-character initials for the default (image-less) avatar.
// A multi-word name uses the first letter of its first two words; a
// single word uses its first two letters; with no name we fall back to the
// email's local-part (before "@") under the same rule. Purely presentational.
export function initials(nameOrEmail: string): string {
  const source = nameOrEmail.includes("@") ? nameOrEmail.split("@")[0] : nameOrEmail;
  const words = source.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
