// First-launch welcome. ONE screen, then the app.
//
// It used to be a five-step wizard (concepts, repos folder, hooks, theme,
// project picker), and almost all of it was teaching ahead of need: what a
// worktree is before there is a project to make one in, which theme before
// anything is on screen to judge it by. That teaching now happens in place,
// as tips pointing at the real controls the moment they matter (the
// getting-started tour, docs/guide.md), and adding a project is the app's own
// Add project dialog rather than a second picker that only existed here.
//
// What is left is what cannot wait for a tip, because each is a decision
// about the machine rather than a thing to learn:
//   - which agent CLIs were found, with a way to point at one PATH missed;
//   - on a Linux AppImage, the launcher entry.
//
// Agent hooks are NOT asked about here. The app turns "install hooks for every
// agent" on and installs them at startup, before this screen exists
// (`migrate_hooks_auto_default`, `syncAgentHooks`), so a checkbox here was a
// question whose answer had already been applied: ticked did nothing, and
// unticked flipped the setting without removing a line. Settings, Agents &
// Terminals is where hooks are shown per agent, with what each writes and a
// Remove that removes.
//
// `welcomed=true` is written by either button. Escape is blocked so setup
// cannot be bypassed by accident.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useUI } from "@/store/ui";
import { useGuide } from "@/store/guide";
import { AppDialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { desktopIntegrationStatus, desktopIntegrationAdd, detectClis, settingsLoad, settingsSave, agentsSave } from "@/lib/ipc";
import { markDesktopEntryAsked } from "@/lib/desktopEntryPrompt";
import { Checkbox } from "@/components/ui/Checkbox";
import type { CliInfo } from "@/lib/types";
import { CliIcon, CLI_LABEL } from "@/icons/cli";
import { TermicMark } from "@/icons/TermicLogo";
import { cn } from "@/lib/utils";
import { dragRegion } from "@/lib/platform";

export function WelcomeDialog() {
  const { t } = useTranslation("dialogs");
  const open = useUI(s => s.welcomeOpen);
  const close = useUI(s => s.closeWelcome);

  // Linux AppImage only: offer the launcher entry here rather than as a
  // separate dialog. Both are modal and this one blocks Escape, so a brand new
  // user would otherwise meet two prompts at once (see lib/desktopEntryPrompt,
  // which stands down until `welcomed`).
  const [desktopAvailable, setDesktopAvailable] = useState(false);
  // TICKED by default, here and only here. The standalone prompt for an
  // existing install still requires an actual click, because it interrupts
  // someone mid-use; this is a setup flow the user opened on purpose, the box
  // is on screen with its own explanation, and unticking it is one click
  // before the button. Unticked, almost nobody would notice it and the
  // feature would exist for the handful of people who read every checkbox.
  const [wantDesktopEntry, setWantDesktopEntry] = useState(true);

  // null until detection answers, so "checking" and "none found" are
  // different screens.
  const [clis, setClis] = useState<CliInfo[] | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset every time it opens so re-running it (rare) starts clean.
  useEffect(() => {
    if (!open) return;
    setClis(null);
    detectClis().then(setClis).catch(() => setClis([]));
    desktopIntegrationStatus()
      .then(st => setDesktopAvailable(st.available && !st.integrated))
      .catch(() => setDesktopAvailable(false));
  }, [open]);

  // Manually point Termic at an agent CLI binary when PATH detection
  // missed it. Common reasons: the user's `claude` is a shell function
  // (only visible to interactive zsh), or termic was launched from
  // Finder where the GUI process gets a stripped PATH that doesn't
  // include /opt/homebrew/bin. Saves the absolute path to the agent
  // registry so the spawn uses it regardless of PATH at launch time.
  async function pickBinary(name: string) {
    const displayName = CLI_LABEL[name] ?? name;
    const picked = await openDialog({
      title: t("welcome.pickBinaryTitle", { name: displayName }),
      multiple: false,
      directory: false,
    });
    if (!picked || typeof picked !== "string") return;
    // Load current settings + update the agent for this CLI in place.
    // We do NOT touch other agents (custom ones the user added stay
    // intact); we DO recreate the entry from defaults if missing.
    try {
      const settings = await settingsLoad();
      const agents = Array.isArray(settings.agents) ? [...settings.agents] : [];
      const idx = agents.findIndex(a => a.id === name);
      if (idx < 0) {
        // Built-in CLI entries are always present (defaults seed on
        // first settings load). If somehow missing, bail rather than
        // synthesize an incomplete Agent — the user can re-trigger
        // the welcome wizard which will re-seed.
        console.error(`agent ${name} not in registry; skipping path save`);
        return;
      }
      agents[idx] = { ...agents[idx], command: picked };
      await agentsSave(agents);
      // Reflect in the local list so the UI updates immediately.
      setClis((clis ?? []).map(c => c.name === name ? { ...c, found: true, path: picked, version: "" } : c));
    } catch (e) { console.error("set binary path failed:", e); }
  }


  async function finish(tour: boolean) {
    setBusy(true);
    try {
      const cur = await settingsLoad();
      await settingsSave({ ...cur, welcomed: true });
      // The launcher entry, if they ticked it. Marked asked either way: they
      // have been shown the question, and the standalone prompt must not put
      // it to them again on the next launch.
      if (desktopAvailable) {
        markDesktopEntryAsked();
        if (wantDesktopEntry) {
          await desktopIntegrationAdd().catch(err => {
            console.error("desktop entry failed:", err);
          });
        }
      }
      // Skipping skips the tour and nothing else: the tips stay armed for the
      // day one of their situations is true.
      const guide = useGuide.getState();
      if (tour) guide.startGuide("welcome"); else guide.skipGuide("welcome");
      close();
    } finally { setBusy(false); }
  }

  const found = (clis ?? []).filter(c => c.found && c.name !== "shell");

  return (
    <AppDialog open={open} onOpenChange={() => {}}
      hideClose className="max-w-[520px]"
    >
      {/* Whole header bar is a drag region so users can move the
          window by grabbing the title strip - same affordance as
          macOS app title bars. */}
      <div
        {...dragRegion()}
        className="mb-3 flex items-center gap-3 -mt-1 cursor-grab active:cursor-grabbing select-none"
      >
        <TermicMark size={40} />
        <div className="truncate text-[18px] font-semibold leading-tight">{t("welcome.title")}</div>
      </div>

      <div className="flex flex-col gap-3">
        <p className="text-[13px] leading-snug text-[var(--color-fg-dim)]">{t("welcome.intro")}</p>

        <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg)] p-3">
          <div className="mb-2 text-[11.5px] uppercase tracking-wider text-[var(--color-fg-dim)]">
            {t("welcome.agentClisTitle")}
          </div>
          {clis === null && (
            <div className="text-[13.5px] text-[var(--color-fg-faint)]">{t("welcome.checking")}</div>
          )}
          {/* Capped: the registry is nine agents and growing, and an
              uncapped list pushed the buttons off a laptop screen. */}
          <div data-testid="welcome-clis" className="max-h-[216px] overflow-y-auto pr-1">
        {(clis ?? []).filter(c => c.name !== "shell").map(c => (
          <div key={c.name} className={cn("flex items-center gap-2 py-1 text-[13.5px]", !c.found && "opacity-70")}>
            {/* Most users will have one or two of these CLIs installed,
                not all four. Painting the absent ones red made every
                wizard look like a wall of failures. Now: found = green
                (status badge), missing = gray (neutral, "not relevant
                here"). The "Set path..." button is still available for
                anything you do want to wire up. */}
            <span className={c.found ? "text-[var(--color-ok)]" : "text-[var(--color-fg-faint)]"}>
              <CliIcon cli={c.name} className="h-4 w-4" />
            </span>
            <span className={cn("min-w-[60px]", !c.found && "text-[var(--color-fg-dim)]")}>{CLI_LABEL[c.name] ?? c.name}</span>
            {c.found ? (
              <span className="truncate font-mono text-[12px] text-[var(--color-fg-dim)]" title={c.path}>
                {c.version || c.path}
              </span>
            ) : (
              <>
                <span className="text-[var(--color-fg-faint)] text-[12px]">{t("welcome.notInstalled")}</span>
                <button
                  type="button"
                  onClick={() => pickBinary(c.name)}
                  className="ml-auto rounded border border-[var(--color-border)] bg-[var(--color-bg-2)] px-2 py-0.5 text-[11.5px] text-[var(--color-fg-dim)] hover:border-[var(--color-accent-soft)] hover:text-[var(--color-fg)]"
                  title={t("welcome.setPathTitle", { name: CLI_LABEL[c.name] ?? c.name })}
                >
                  {t("welcome.setPath")}
                </button>
              </>
            )}
          </div>
        ))}
          </div>
          {clis !== null && found.length === 0 && (
            <p data-testid="welcome-no-agents" className="mt-2 text-[12px] leading-snug text-[var(--color-fg-dim)]">
              {t("welcome.noAgents")}
            </p>
          )}
        </div>

        {/* Ticked by default: see the state above for why this one differs
            from the standalone prompt. It still writes into the user's own
            ~/.local/share, so it is never hidden or implied. */}
        {desktopAvailable && (
          <label
            data-testid="welcome-desktop-entry"
            className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-2)] px-3 py-2.5"
          >
            <Checkbox
              checked={wantDesktopEntry}
              onChange={setWantDesktopEntry}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium">{t("welcome.desktopEntryTitle")}</span>
              <span className="mt-0.5 block text-[12px] text-[var(--color-fg-dim)]">
                {t("welcome.desktopEntryHint")}
              </span>
            </span>
          </label>
        )}
      </div>

      {/* Skip on the far left, away from the button that continues: it is the
          one that declines something. Both finish setup; they differ only in
          whether the tour starts. */}
      <div className="mt-5 flex items-center justify-between gap-2">
        <Button variant="ghost" type="button" data-testid="welcome-skip-tour" onClick={() => finish(false)} disabled={busy}>
          {t("welcome.skipTour")}
        </Button>
        <Button variant="primary" type="button" data-testid="welcome-start" onClick={() => finish(true)} disabled={busy}>
          {busy ? t("welcome.starting") : t("welcome.showMeAround")}
        </Button>
      </div>
    </AppDialog>
  );
}
