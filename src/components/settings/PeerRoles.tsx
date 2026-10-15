// Role presets for a paired computer's note ("What it is for"). A role is
// only a starting text: clicking one fills the note, which the person can
// edit, and agents read the note (MCP instructions, `termic peer list`).
// Shared by the after-pairing dialog and the paired list in Settings.

import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export const PEER_ROLES = ["orchestrator", "executor", "worker"] as const;

export function PeerRoleChips({ note, onPick, testid }: {
  /** `label` is the role's short name ("Orchestrator"), for callers that
   *  also offer it as the computer's local name. */
  note: string; onPick: (note: string, label: string) => void; testid: string;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-wrap gap-1.5" data-testid={testid}>
      {PEER_ROLES.map(r => {
        const text = t(`peers.roles.${r}.note`);
        const active = note.trim() === text;
        return (
          <button
            key={r}
            type="button"
            data-role={r}
            aria-pressed={active}
            onClick={() => onPick(text, t(`peers.roles.${r}.label`))}
            className={cn(
              "rounded-full border px-2.5 py-0.5 text-[12px]",
              active
                ? "border-[var(--color-accent)] bg-[var(--color-accent-deep)]/15 text-[var(--color-fg)]"
                : "border-[var(--color-border)] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]",
            )}
          >
            {t(`peers.roles.${r}.label`)}
          </button>
        );
      })}
    </div>
  );
}
