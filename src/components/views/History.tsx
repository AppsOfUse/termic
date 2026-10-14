import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useApp } from "@/store/app";
import { useUI } from "@/store/ui";
import { i18n } from "@/lib/i18n";
import { taskRestore, taskDelete, openPath } from "@/lib/ipc";
import { historyMatches } from "@/lib/historySearch";
import { prRef } from "@/lib/forge";
import { PR_STATE_STYLE } from "@/components/task/PrCard";
import { CliIcon, CLI_BRAND_COLOR, resolveIconId } from "@/icons/cli";
import { TaskLocationIcon } from "@/components/TaskLocationIcon";
import { DropdownRoot, DropdownTrigger, DropdownMenu, DropdownItem, DropdownSeparator } from "@/components/ui/Dropdown";
import { cn } from "@/lib/utils";
import { Check, ChevronDown, Search, Trash2 } from "lucide-react";
import type { Task } from "@/lib/types";

function groupLabel(iso: string, t: TFunction): string {
  const diffDays = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (diffDays === 0) return t("history.today");
  if (diffDays === 1) return t("history.yesterday");
  if (diffDays < 7)  return t("history.daysAgo", { count: diffDays });
  if (diffDays < 14) return t("history.lastWeek");
  if (diffDays < 21) return t("history.weeksAgo", { count: 2 });
  if (diffDays < 28) return t("history.weeksAgo", { count: 3 });
  // Dates follow the UI language, not the OS locale: a Chinese UI over an
  // English macOS still reads 三月, matching every other string on the page.
  return new Intl.DateTimeFormat(i18n.language, { month: "long", year: "numeric" }).format(new Date(iso));
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat(i18n.language, {
    month: "short", day: "numeric",
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  }).format(d);
}

export function HistoryView() {
  const { t } = useTranslation("chrome");
  const projects  = useApp(s => s.projects);
  const tasks = useApp(s => s.tasks);
  const agents    = useApp(s => s.agents);
  const loadAll   = useApp(s => s.loadAll);
  const setActive = useApp(s => s.setActiveTask);
  const projectFilter     = useApp(s => s.view.projectId);
  const setHistoryProject = useApp(s => s.setHistoryProject);

  useEffect(() => { void loadAll(); }, []);

  const [query, setQuery]       = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<Set<string>>(new Set());
  const [emptying, setEmptying]   = useState(false);

  // Everything archived, filters ignored. Feeds the project dropdown (so it
  // only offers projects that have something to show, with counts) and the
  // "Empty archive" scope below.
  const archivedAll = useMemo(() => tasks.filter(w => w.archived), [tasks]);

  // Projects with at least one archived task, by name. A project that has
  // been removed can't be picked (no name to show), which is fine: its
  // tasks still appear under All projects as "Unknown".
  const projectOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const w of archivedAll) counts.set(w.project_id, (counts.get(w.project_id) ?? 0) + 1);
    return projects
      .filter(p => counts.has(p.id))
      .map(p => ({ id: p.id, name: p.name, count: counts.get(p.id)! }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [archivedAll, projects]);

  // A filter pointing at a project with nothing archived (its last task was
  // restored or deleted, or the project was removed) falls back to All, so
  // the page never sits on an empty list the dropdown can't even name.
  const activeProject = projectOptions.find(p => p.id === projectFilter);
  // `setHistoryProject` is in the deps because the effect calls it. It is a
  // Zustand action defined in the store creator (store/app.ts), so its
  // identity never changes and listing it cannot re-run this effect.
  useEffect(() => {
    if (projectFilter && !activeProject) setHistoryProject(undefined);
  }, [projectFilter, activeProject, setHistoryProject]);

  const archived = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...archivedAll.filter(w => {
      if (activeProject && w.project_id !== activeProject.id) return false;
      if (!q) return true;
      // Name, branches, project, agent, and the PR: its number in any
      // spelling (exact), title, link and last known state.
      return historyMatches(w, projects.find(x => x.id === w.project_id)?.name ?? "", q);
    })].sort((a, b) => (b.archived_at ?? b.created).localeCompare(a.archived_at ?? a.created));
  }, [archivedAll, projects, query, activeProject]);

  const groups = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const w of archived) {
      const key = groupLabel(w.archived_at ?? w.created, t);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(w);
    }
    return [...map.entries()];
  }, [archived, t]); // t: group labels re-translate on a live language switch

  // "Empty archive" ignores the search box (it's about the archive, not what
  // the query happens to show) but honors the project filter: with a project
  // picked, it empties that project's archive only. The confirmation names
  // the real count and project so the two can never disagree.
  const emptyScope = activeProject
    ? archivedAll.filter(w => w.project_id === activeProject.id)
    : archivedAll;

  // Hard-delete every archived task in scope. Each one is already archived, so its
  // worktree is gone and this only wipes the record (task_delete re-runs the
  // archive path harmlessly, then removes the json). Sequential because the
  // deletes all rewrite the same tasks dir; one failure is counted and
  // reported at the end rather than aborting the rest, so a single stuck
  // record can't leave the archive half-emptied with no explanation.
  async function emptyArchive() {
    const scopeId = activeProject?.id;
    const doomed = useApp.getState().tasks.filter(w => w.archived && (!scopeId || w.project_id === scopeId));
    if (doomed.length === 0) return;
    const ok = await useUI.getState().askConfirm({
      title: activeProject
        ? t("history.confirmTitleProject", { project: activeProject.name })
        : t("history.confirmTitle"),
      message: activeProject
        ? (doomed.length === 1
          ? t("history.confirmMessageOneProject", { count: doomed.length, project: activeProject.name })
          : t("history.confirmMessageManyProject", { count: doomed.length, project: activeProject.name }))
        : (doomed.length === 1
          ? t("history.confirmMessageOne", { count: doomed.length })
          : t("history.confirmMessageMany", { count: doomed.length })),
      confirmLabel: t("history.confirmLabel"),
      destructive: true,
    });
    if (!ok) return;
    setEmptying(true);
    let failed = 0;
    for (const w of doomed) {
      try { await taskDelete(w.id); } catch (err) { failed++; console.error("task_delete failed:", err); }
    }
    await loadAll();
    setEmptying(false);
    if (failed > 0) {
      useUI.getState().pushToast(t("history.deleteFailed", { failed, total: doomed.length }), "error");
    } else {
      useUI.getState().pushToast(t("history.emptied", { count: doomed.length }), "success");
    }
  }

  async function restore(id: string) {
    setRestoring(prev => new Set(prev).add(id));
    try {
      const task = await taskRestore(id);
      await loadAll();
      setActive(task.id);
    } catch (err) {
      useUI.getState().pushToast(typeof err === "string" ? err : t("restoreFailed"), "error");
    } finally {
      setRestoring(prev => { const s = new Set(prev); s.delete(id); return s; });
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden" data-testid="history-root">
      {/* Search bar */}
      <div className="shrink-0 flex items-center gap-2.5 border-b border-[var(--color-border-soft)] px-6 py-3 text-[var(--color-fg-faint)]">
        <Search className="h-4 w-4 shrink-0" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t("history.filterPlaceholder")}
          data-testid="history-search"
          className="flex-1 bg-transparent text-[13.5px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] outline-none"
        />
        {/* Project filter. Single-select; lives in the store (view.projectId)
            so the sidebar's Resume › More… can land here pre-filtered. */}
        {projectOptions.length > 0 && (
          <DropdownRoot>
            <DropdownTrigger asChild>
              <button
                type="button"
                data-history-project-filter
                title={t("history.projectFilterTip")}
                className={cn(
                  "flex min-w-0 max-w-[200px] shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12.5px] transition-colors hover:bg-[var(--color-hover)]",
                  activeProject ? "text-[var(--color-fg)]" : "text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]",
                )}
              >
                <span className="truncate">{activeProject?.name ?? t("history.allProjects")}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              </button>
            </DropdownTrigger>
            <DropdownMenu align="end" className="max-w-[280px]">
              <ProjectItem label={t("history.allProjects")} count={archivedAll.length} active={!activeProject} onSelect={() => setHistoryProject(undefined)} />
              <DropdownSeparator />
              {projectOptions.map(p => (
                <ProjectItem key={p.id} label={p.name} count={p.count} active={activeProject?.id === p.id} onSelect={() => setHistoryProject(p.id)} />
              ))}
            </DropdownMenu>
          </DropdownRoot>
        )}
        {/* Permanent delete, so it sits here as a plain quiet control rather
            than on every row: the archive is the recycle bin, and emptying it
            is one deliberate act. Hidden entirely when there's nothing to
            empty, so the page never offers a no-op destructive button. */}
        {emptyScope.length > 0 && (
          <button
            type="button"
            onClick={emptyArchive}
            disabled={emptying}
            title={activeProject
              ? t("history.emptyArchiveTipProject", { project: activeProject.name })
              : t("history.emptyArchiveTip")}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] transition-colors",
              emptying
                ? "text-[var(--color-fg-faint)]"
                : "text-[var(--color-fg-dim)] hover:bg-[var(--color-hover)] hover:text-[var(--color-err)]",
            )}
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            {emptying ? t("history.emptying") : t("history.emptyArchive")}
          </button>
        )}
      </div>

      {/* List */}
      <div className="min-h-0 flex-1 overflow-auto px-6 py-4" data-testid="history-list">
        <div className="mx-auto max-w-[1400px]">
          {archived.length > 0 && (
            // Column heads, on the same grid as the rows.
            <div className={cn(HISTORY_GRID, "px-3 pb-1 text-[11px] uppercase tracking-[0.08em] text-[var(--color-fg-faint)]")}>
              <span />
              <span>{t("history.colProject")}</span>
              <span>{t("history.colTask")}</span>
              <span>{t("history.colBranch")}</span>
              <span>{t("history.colPr")}</span>
              <span className="text-right">{t("history.colArchived")}</span>
              <span />
            </div>
          )}
          {archived.length === 0 ? (
            <p className="py-8 text-[13.5px] text-[var(--color-fg-dim)]">
              {query ? t("history.noMatch")
                : activeProject ? t("history.noArchivedInProject", { project: activeProject.name })
                : t("history.noArchived")}
            </p>
          ) : groups.map(([label, task]) => (
            <div key={label} className="mb-2">
              <div className="flex items-baseline gap-2 px-3 py-2">
                <span className="text-[12px] font-medium text-[var(--color-fg-dim)]">{label}</span>
                <span className="text-[12px] text-[var(--color-fg-faint)]">{task.length}</span>
              </div>
              {task.map(w => {
                const proj        = projects.find(x => x.id === w.project_id);
                const isRestoring = restoring.has(w.id);
                const isHovered   = hoveredId === w.id && !isRestoring;
                const iconId      = resolveIconId(w.cli, agents);
                return (
                  <div
                    key={w.id}
                    data-history-row={w.id}
                    onMouseEnter={() => setHoveredId(w.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    data-history-pr={w.pr_number ?? undefined}
                    className={cn(
                      HISTORY_GRID,
                      "rounded-md px-3 py-2 text-[13px] select-none",
                      isRestoring ? "opacity-50" : "",
                      isHovered ? "bg-[var(--color-hover)]" : "",
                    )}
                  >
                    <span className={cn("shrink-0", CLI_BRAND_COLOR[iconId] || "text-[var(--color-fg-faint)]")}>
                      <CliIcon cli={iconId} className="h-4 w-4" />
                    </span>

                    <span className="min-w-0 truncate text-[var(--color-fg-dim)]">
                      {proj?.name ?? t("history.unknownProject")}
                    </span>

                    <span className="flex min-w-0 items-center gap-1.5">
                      <TaskLocationIcon isMainCheckout={w.is_main_checkout} size="h-3 w-3" />
                      <span className="min-w-0 truncate font-medium text-[var(--color-fg)]" title={w.name}>{w.name}</span>
                    </span>

                    {/* The branch, and what it was cut from. A main-checkout
                        task has no branch of its own. */}
                    <span className="flex min-w-0 flex-col font-mono text-[11.5px] leading-tight">
                      {!w.is_main_checkout && w.branch ? (
                        <>
                          <span className="truncate text-[var(--color-fg-dim)]" title={w.branch}>{w.branch}</span>
                          {w.base_branch && (
                            <span className="truncate text-[var(--color-fg-faint)]" title={w.base_branch}>
                              {t("history.fromBase", { base: w.base_branch })}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-[var(--color-fg-faint)]">{t("history.mainCheckout")}</span>
                      )}
                    </span>

                    <HistoryPrCell task={w} />

                    <span className="text-right text-[12.5px] tabular-nums text-[var(--color-fg-faint)]">
                      {fmtDate(w.archived_at ?? w.created)}
                    </span>

                    <span className="flex justify-end">
                      {isRestoring ? (
                        <span className="text-[12.5px] text-[var(--color-fg-dim)]">{t("history.restoring")}</span>
                      ) : (
                        <button
                          onClick={() => restore(w.id)}
                          className={cn(
                            "text-[12.5px] font-medium text-[var(--color-accent)] hover:underline",
                            // Always there for the keyboard and for a reader
                            // scanning for one PR; quiet until the row is.
                            !isHovered && "opacity-0 focus:opacity-100",
                          )}
                        >
                          {t("history.restore")}
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Agent | project | task | branch | PR | archived | restore. One template
 *  for the head and every row so the columns line up. */
const HISTORY_GRID = "grid grid-cols-[20px_minmax(90px,140px)_minmax(140px,1.4fr)_minmax(140px,1.2fr)_minmax(180px,2fr)_76px_72px] items-center gap-x-4";

/** The PR as this task last knew it: state, number (opens it), title, and
 *  when that state was seen. A dash for a task that never had one. */
function HistoryPrCell({ task }: { task: Task }) {
  const { t } = useTranslation("chrome");
  const { t: tp } = useTranslation("panels");
  if (!task.pr_number) return <span className="text-[var(--color-fg-faint)]">-</span>;
  const style = task.pr_state ? PR_STATE_STYLE[task.pr_state] : null;
  const Icon = style?.Icon;
  const seen = task.pr_state_at ? fmtDate(task.pr_state_at) : null;
  return (
    <span className="flex min-w-0 items-center gap-1.5" data-testid="history-pr">
      {Icon && <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: style!.color }} />}
      <button
        type="button"
        disabled={!task.pr_url}
        onClick={(e) => { e.stopPropagation(); if (task.pr_url) void openPath(task.pr_url).catch(() => {}); }}
        title={task.pr_url ?? undefined}
        className="shrink-0 font-mono text-[12px] text-[var(--color-fg)] hover:underline disabled:no-underline"
      >
        {prRef(task.pr_provider, task.pr_number)}
      </button>
      {style && (
        <span
          data-pr-state={task.pr_state}
          title={seen ? t("history.prStateSeen", { date: seen }) : undefined}
          className="shrink-0 text-[11.5px]"
          style={{ color: style.color }}
        >
          {tp(style.labelKey)}
        </span>
      )}
      {task.pr_title && (
        <span className="min-w-0 truncate text-[12px] text-[var(--color-fg-dim)]" title={task.pr_title}>{task.pr_title}</span>
      )}
    </span>
  );
}

function ProjectItem({ label, count, active, onSelect }: { label: string; count: number; active: boolean; onSelect: () => void }) {
  return (
    // The row's text is the name AND a trailing count, so a spec matching the
    // rendered text has to parse it, and "Website" would match "Website
    // Redesign" on any leading-text comparison. The name is carried here
    // exactly, which is a comparison instead of a guess.
    <DropdownItem onSelect={onSelect} className="items-center" data-project-name={label}>
      <Check className={cn("h-3.5 w-3.5 shrink-0", !active && "opacity-0")} />
      <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
      <span className="shrink-0 pl-3 text-[11px] tabular-nums text-[var(--color-fg-faint)]">{count}</span>
    </DropdownItem>
  );
}
