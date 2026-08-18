/**
 * The display label for a piece of evidence, mirroring the title fallback in
 * `listChangeEvents` (prTitle → commit first line → taskTitle → "Untitled").
 *
 * A Notion task keeps its title in `taskTitle`, NOT `prTitle` (see
 * ingest-notion-task.ts), so a chain that stops at `prTitle` renders task
 * evidence as an empty string — which used to leave nothing but a "Task" chip
 * on the row. `"Untitled"` closes the last gap: an empty label would now be an
 * invisible, unclickable evidence row.
 */
export function eventLabel(event: {
  type: "commit" | "pull_request" | "task";
  prTitle: string | null;
  commitMessage: string | null;
  taskTitle: string | null;
}): string {
  const firstLine = event.commitMessage?.split("\n")[0]?.trim();
  if (event.type === "commit") return firstLine || event.prTitle || "Untitled";
  return event.prTitle || event.taskTitle || firstLine || "Untitled";
}
