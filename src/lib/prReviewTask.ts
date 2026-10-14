// Start a PR review from the GUI (the Review a PR dialog). The CLI and MCP
// reach the same result through `new_task` with a `pr` (lib/cliRpc.ts),
// which shares every step below except the existing-task shortcut and the
// untracked prompt seed.

import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";
import { createQuickTask } from "@/lib/quickTask";
import { seedPromptWhenReady, SETUP_SPAWN_DEADLINE_MS } from "@/lib/seedPrompt";
import { runPrompt } from "@/lib/runPrompt";
import { fetchPrForReview, checkoutPrInMain, prReviewPrompt, reviewTaskName } from "@/lib/prReview";
import type { Prompt } from "@/store/prompts";
import type { Task } from "@/lib/types";

export type ReviewWhere = "worktree" | "main";

/** The review task already open for this PR, if any. Matched by name, which
 *  `reviewTaskName` keeps stable per PR. */
export function existingReviewTask(projectId: string, n: number): Task | undefined {
  const name = reviewTaskName(n).toLowerCase();
  return useApp.getState().tasks.find(
    t => !t.archived && t.project_id === projectId && t.name.toLowerCase() === name,
  );
}

/** Fetch the PR, put its branch where the user asked, and seed the review
 *  prompt. A PR that already has a review task gets a fresh agent tab in
 *  that task instead of a second checkout of the same branch (git refuses
 *  that anyway). Returns the task and whether it was reused. */
export async function startPrReview(opts: {
  projectId: string;
  number: number;
  where: ReviewWhere;
  cli: string;
  prompt: Prompt;
}): Promise<{ task: Task; reused: boolean }> {
  const { projectId, number, where, cli, prompt } = opts;
  const { pr, branch } = await fetchPrForReview(projectId, number);
  const body = prReviewPrompt(pr, prompt.body);

  const open = existingReviewTask(projectId, number);
  if (open) {
    useApp.getState().setActiveTask(open.id);
    runPrompt(open.id, { ...prompt, body }, { kind: "new", cli });
    return { task: open, reused: true };
  }

  if (where === "main") {
    // The live checkout itself moves, which every main-checkout task, the
    // editor and any dev server share: said out loud, like the New Task
    // dialog's PR pick.
    const res = await checkoutPrInMain(projectId, branch);
    useUI.getState().pushToast(
      res.conflicted
        ? i18n.t("dialogs:newTask.prCheckedOutConflict", { branch })
        : res.stashed
          ? i18n.t("dialogs:newTask.prCheckedOutStashed", { branch })
          : i18n.t("dialogs:newTask.prCheckedOut", { branch }),
      res.conflicted ? "error" : "info",
    );
    if (res.conflicted) throw new Error(i18n.t("dialogs:newTask.prCheckedOutConflict", { branch }));
  }

  const task = await createQuickTask({
    projectId,
    mode: where === "main" ? "repo_root" : "worktree",
    cli,
    name: reviewTaskName(number),
    ...(where === "worktree" ? { branch, checkoutExisting: true } : {}),
  });
  // A worktree runs its setup script first, so the agent may not spawn for
  // a while: the long deadline, as the issue path uses.
  seedPromptWhenReady(task.id, body, SETUP_SPAWN_DEADLINE_MS);
  return { task, reused: false };
}
