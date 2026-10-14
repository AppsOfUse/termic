// The way out of a custom Claude status line, in the three places it is
// offered: the task footer's "usage n/a" chip, the usage panel of a task whose
// own status line already reports, and the project's Settings page.
//
// Claude has ONE status line slot. Termic reads plan usage and the context
// window from the script it installs there, so a project (or a user) with a
// status line of their own gets neither, silently. The fix is not to replace
// their script: it is a prompt they paste at the agent that owns it, which
// teaches the script to report as well (`statusLineAgentPrompt`).
//
// It used to be offered in exactly one place, the "usage n/a" chip, which
// goes away the moment the script reports anything. So a script taught by an
// older prompt (usage, no context) or taught half right had no way back to
// the prompt at all. Settings is the place that never goes away.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import * as ipc from "@/lib/ipc";
import { writeClipboardText } from "@/lib/clipboard";
import { blockedReason, blocksUsageFeed, statusLineAgentPrompt, type StatusLineOwner } from "@/lib/agentUsage";

/** The copy link and the line under it saying where to paste. */
export function CopyStatusLinePrompt({ owner }: { owner: StatusLineOwner }) {
  const { t } = useTranslation("task");
  const [copied, setCopied] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="status-line-copy-prompt"
        onClick={() => {
          void writeClipboardText(statusLineAgentPrompt(owner))
            .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); })
            .catch(() => {});
        }}
        className="flex items-center gap-1.5 text-[12px] text-[var(--color-fg-dim)] underline decoration-dotted underline-offset-2 hover:text-[var(--color-fg)]"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? t("common:copied") : t("agentChip.copyPrompt")}
      </button>
      <p className="mt-1 text-[12px] text-[var(--color-fg-faint)]">
        {t("agentChip.copyPromptHint")}
      </p>
    </>
  );
}

/** Settings > a project > More. Asks who owns Claude's status line for THIS
 *  project, because the answer is per project: a repo can ship its own, a
 *  local override outranks that, and a user-level one applies everywhere. */
export function ProjectStatusLine({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation("task");
  // undefined while the question is out, null when it could not be answered.
  const [owner, setOwner] = useState<StatusLineOwner | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setOwner(undefined);
    ipc.usageStatusLineOwner("claude", projectPath)
      .then(o => { if (!cancelled) setOwner(o); })
      .catch(() => { if (!cancelled) setOwner(null); });
    return () => { cancelled = true; };
  }, [projectPath]);

  if (owner === undefined) return null;
  if (!owner || !blocksUsageFeed(owner)) {
    return (
      <p data-testid="project-status-line" data-owner={owner?.owner ?? "unknown"} className="text-[12.5px] text-[var(--color-fg-dim)]">
        {t("agentChip.statusLineOurs")}
      </p>
    );
  }
  return (
    <div data-testid="project-status-line" data-owner={owner.owner} className="flex flex-col gap-2 text-[12.5px] text-[var(--color-fg-dim)]">
      <p>{blockedReason(owner)}</p>
      {/* Name the FILE: three settings files can hold this, and which one is
          in force is not obvious (a local one outranks a committed one). */}
      <p className="break-all text-[var(--color-fg-faint)]"><code className="font-mono">{owner.path}</code></p>
      <div><CopyStatusLinePrompt owner={owner} /></div>
    </div>
  );
}
