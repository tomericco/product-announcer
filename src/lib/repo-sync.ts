import { and, eq } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { repos } from "../db/schema";

export async function addSelectedRepos(
  tenantId: string,
  installationId: string,
  selections: Array<{ fullName: string; branch: string }>,
  database: typeof defaultDb = defaultDb
): Promise<void> {
  for (const selection of selections) {
    const existing = await database
      .select()
      .from(repos)
      .where(and(eq(repos.tenantId, tenantId), eq(repos.githubRepoFullName, selection.fullName)))
      .limit(1);

    if (existing.length > 0) {
      await database
        .update(repos)
        .set({ githubInstallationId: installationId, watchedBranch: selection.branch })
        .where(eq(repos.id, existing[0].id));
      continue;
    }

    await database.insert(repos).values({
      tenantId,
      githubRepoFullName: selection.fullName,
      githubInstallationId: installationId,
      watchedBranch: selection.branch,
      sourceTypes: ["pr"],
    });
  }
}
