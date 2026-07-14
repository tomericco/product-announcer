export function parseRepoSelections(formData: FormData): Array<{ fullName: string; branch: string }> {
  const count = Number(formData.get("repoCount") ?? 0);
  const selections: Array<{ fullName: string; branch: string }> = [];

  for (let i = 0; i < count; i++) {
    if (formData.get(`repo-${i}-selected`) !== "on") continue;

    const fullName = formData.get(`repo-${i}-fullName`) as string | null;
    const branch = ((formData.get(`repo-${i}-branch`) as string | null) ?? "").trim();

    if (fullName && branch) {
      selections.push({ fullName, branch });
    }
  }

  return selections;
}
