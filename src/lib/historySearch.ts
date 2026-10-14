// What the History page's search box matches an archived task against.
// Pure so the rules are unit-tested: the point of searching history is to
// find an old task from whatever you remember about it, and the PR number is
// often the only thing left (the branch was deleted at merge, the task name
// was an agent's guess).

import type { Task } from "@/lib/types";
import { parsePrRef } from "@/lib/prReview";

/** True when `task` matches the query `raw`. Empty matches everything.
 *
 *  A query that reads as a PR reference ("123", "#123", "!123", a PR link)
 *  matches that PR's number EXACTLY, so "#12" does not also turn up PR 120.
 *  Every other query is a case-insensitive substring of the task name, its
 *  branch and base branch, the project name, the agent, and the PR's title,
 *  link and last known state. A bare number does both: it finds PR 123 and
 *  a task named "fix-123". */
export function historyMatches(task: Task, projectName: string, raw: string): boolean {
  const q = raw.trim().toLowerCase();
  if (!q) return true;
  const pr = parsePrRef(q);
  if (pr && task.pr_number === pr) return true;
  // "#123" / "!123" / a link asked for a PR and nothing else.
  if (pr && (/^[#!]/.test(q) || /^https?:\/\//.test(q))) return false;
  const hay = [
    task.name, task.branch, task.base_branch, projectName, task.cli,
    task.pr_title ?? "", task.pr_url ?? "", task.pr_state ?? "",
  ];
  return hay.some(h => h.toLowerCase().includes(q));
}
