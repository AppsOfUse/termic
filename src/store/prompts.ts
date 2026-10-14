// Prompt library — a user-managed registry of reusable prompts fired from the
// Prompts dropdown. A prompt is just title + body; the DESTINATION (which agent,
// or a new one) is chosen at fire-time, not stored here. See lib/runPrompt.ts.
//
// Storage model (like the agents registry): built-ins are NOT frozen into
// storage. We persist only the DELTA from the shipped defaults:
//   - customs:        user-created prompts (full content)
//   - overrides:      edited built-ins (id -> {title, body}); presence == MODIFIED
//   - deletedBuiltins built-ins the user removed
//   - disabled:       prompts hidden from the menu
//   - order:          display order of ids
//   - labels:         a prompt's labels where they differ from its default
//                     (id -> the full list); see DEFAULT_LABELS. 1.16.0
//                     stored a single "Code review" flag as `review`
//                     (id -> on/off), read once and folded into this.
// An UNEDITED built-in therefore always renders the current app default, so a
// better default shipped in a future version reaches users who never touched it.

import { create } from "zustand";
import { i18n } from "@/lib/i18n";
import { REVIEW_PROMPT } from "@/lib/review";
import {
  WRITE_TESTS_PROMPT, SECURITY_REVIEW_PROMPT, EXPLAIN_CHANGES_PROMPT, COMMIT_PROMPT,
  COMMIT_PUSH_PROMPT, VERIFY_PROMPT, FIX_BUG_PROMPT, STATUS_PROMPT,
  UPDATE_DOCS_PROMPT, RESEARCH_PROMPT, CONTINUE_PROMPT, SIMPLIFY_PROMPT,
  WORK_ISSUE_PROMPT, HANDOFF_PROMPT, FIX_MERGE_CONFLICT_PROMPT, DEEP_REVIEW_PROMPT,
} from "@/lib/builtinPrompts";
import { scoped } from "@/lib/profileScope";

export interface Prompt {
  id: string;
  title: string;
  body: string;
  builtin: boolean;
  /** Hidden from the dropdown when false, without deleting it. */
  enabled: boolean;
  /** Built-in only: true once the user edited it away from the shipped text. */
  modified: boolean;
  /** The prompt's labels, user-chosen. `CODE_REVIEW_LABEL` among them puts
   *  it in the Review a PR dialog. */
  labels: string[];
  /** Carries `CODE_REVIEW_LABEL`: offered by the Review a PR dialog and
   *  picked by `termic review` when no prompt is named. */
  forReview: boolean;
}

/** The one label the app itself reads: a prompt carrying it is a code
 *  review prompt. Shown as "Code review" (i18n); stored as this key so a
 *  language switch does not untag anything. */
export const CODE_REVIEW_LABEL = "code-review";

/** Labels a built-in starts with. Every other prompt, custom ones included,
 *  starts with none. */
export const DEFAULT_LABELS: Readonly<Record<string, readonly string[]>> = {
  "builtin:review": [CODE_REVIEW_LABEL],
  "builtin:deep-review": [CODE_REVIEW_LABEL],
};
/** Kept for callers that only ask "which built-ins are review prompts". */
export const REVIEW_BY_DEFAULT: readonly string[] = Object.keys(DEFAULT_LABELS);

const LABEL_MAX = 40;

/** A typed label as stored: trimmed, inner whitespace collapsed, capped. Any
 *  spelling of "code review" is the built-in label, so typing it by hand
 *  tags the prompt for Review a PR rather than making a look-alike. "" for
 *  nothing usable. */
export function normalizeLabel(raw: string): string {
  const t = raw.trim().replace(/\s+/g, " ").slice(0, LABEL_MAX);
  if (!t) return "";
  const key = t.toLowerCase().replace(/[\s_]+/g, "-");
  return key === CODE_REVIEW_LABEL ? CODE_REVIEW_LABEL : t;
}

/** Same label, ignoring case. */
export function sameLabel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Every label in use, built-in first, then the rest by name. */
export function allLabels(prompts: readonly Prompt[]): string[] {
  const seen: string[] = [CODE_REVIEW_LABEL];
  for (const p of prompts) for (const l of p.labels) if (!seen.some(x => sameLabel(x, l))) seen.push(l);
  return [seen[0], ...seen.slice(1).sort((a, b) => a.localeCompare(b))];
}

/** The prompts the Review a PR dialog offers, in library order: tagged,
 *  enabled, and with something in them. */
export function reviewPrompts(prompts: readonly Prompt[]): Prompt[] {
  return prompts.filter(p => p.forReview && p.enabled && p.body.trim() !== "");
}

interface BuiltinDef { id: string; title: string; body: string }

// Starter library: the "ship a change" lifecycle, every one diff-aware so it
// leverages the worktree. Users edit, reorder, disable, delete, or add their own.
// The second block covers the prompts terminal users reach for most
// between agent turns: verify, fix, status, continue, docs, research.
export const DEFAULT_PROMPTS: readonly BuiltinDef[] = [
  { id: "builtin:review",          title: "Review",               body: REVIEW_PROMPT },
  { id: "builtin:deep-review",     title: "Deep review",          body: DEEP_REVIEW_PROMPT },
  { id: "builtin:write-tests",     title: "Write tests",          body: WRITE_TESTS_PROMPT },
  { id: "builtin:security-review", title: "Security review",      body: SECURITY_REVIEW_PROMPT },
  { id: "builtin:explain-changes", title: "Explain the changes",  body: EXPLAIN_CHANGES_PROMPT },
  { id: "builtin:commit",          title: "Commit",               body: COMMIT_PROMPT },
  { id: "builtin:commit-push",     title: "Commit and push",      body: COMMIT_PUSH_PROMPT },
  { id: "builtin:merge-conflict",  title: "Fix merge conflicts",  body: FIX_MERGE_CONFLICT_PROMPT },
  { id: "builtin:verify",          title: "Verify end to end",    body: VERIFY_PROMPT },
  { id: "builtin:fix-bug",         title: "Fix the bug",          body: FIX_BUG_PROMPT },
  { id: "builtin:work-issue",      title: "Work on the issue",    body: WORK_ISSUE_PROMPT },
  { id: "builtin:simplify",        title: "Simplify",             body: SIMPLIFY_PROMPT },
  { id: "builtin:status",          title: "What is the state?",   body: STATUS_PROMPT },
  { id: "builtin:continue",        title: "Continue from last",   body: CONTINUE_PROMPT },
  { id: "builtin:handoff",         title: "Hand off to another agent", body: HANDOFF_PROMPT },
  { id: "builtin:update-docs",     title: "Update the docs",      body: UPDATE_DOCS_PROMPT },
  { id: "builtin:research",        title: "Research first",       body: RESEARCH_PROMPT },
];

// Display titles for built-ins resolve through backend:prompts at render, so
// a language switch relabels the library without touching stored data (the
// stored title stays the canonical English default; an override replaces it
// outright). Customs always render what the user typed.
const PROMPT_TITLE_KEYS: Record<string, string> = {
  "builtin:review": "review",
  "builtin:deep-review": "deepReview",
  "builtin:write-tests": "writeTests",
  "builtin:security-review": "securityReview",
  "builtin:explain-changes": "explainChanges",
  "builtin:commit": "commit",
  "builtin:commit-push": "commitPush",
  "builtin:merge-conflict": "fixMergeConflict",
  "builtin:verify": "verify",
  "builtin:fix-bug": "fixBug",
  "builtin:work-issue": "workIssue",
  "builtin:simplify": "simplify",
  "builtin:status": "status",
  "builtin:continue": "continue",
  "builtin:handoff": "handoff",
  "builtin:update-docs": "updateDocs",
  "builtin:research": "research",
};

/** What a prompt is CALLED on screen. Pass the calling component's `t` so a
 *  useTranslation subscriber re-renders on a language switch (and include it
 *  in any memo deps); without one it resolves through the global i18n. */
export function promptTitle(
  p: Pick<Prompt, "id" | "title" | "builtin" | "modified">,
  t?: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (p.builtin && !p.modified) {
    const key = PROMPT_TITLE_KEYS[p.id];
    if (key) {
      const resolved = t
        ? t(`backend:prompts.${key}`)
        : i18n.t(`backend:prompts.${key}`);
      if (resolved) return resolved;
    }
  }
  return p.title;
}

const LS_KEY = scoped("promptLibrary");

interface StoredCustom { id: string; title: string; body: string }

interface Persisted {
  customs: StoredCustom[];
  overrides: Record<string, { title: string; body: string }>;
  deletedBuiltins: string[];
  disabled: string[];
  order: string[];
  labels: Record<string, string[]>;
}

const EMPTY: Persisted = {
  customs: [], overrides: {}, deletedBuiltins: [], disabled: [], order: [], labels: {},
};

function isCustom(c: unknown): c is StoredCustom {
  return !!c && typeof c === "object"
    && typeof (c as StoredCustom).id === "string"
    && typeof (c as StoredCustom).title === "string"
    && typeof (c as StoredCustom).body === "string";
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...EMPTY };
    const s = JSON.parse(raw) as Partial<Persisted>;
    return {
      customs: Array.isArray(s.customs) ? s.customs.filter(isCustom) : [],
      overrides: s.overrides && typeof s.overrides === "object" ? s.overrides : {},
      deletedBuiltins: Array.isArray(s.deletedBuiltins) ? s.deletedBuiltins : [],
      disabled: Array.isArray(s.disabled) ? s.disabled : [],
      order: Array.isArray(s.order) ? s.order : [],
      labels: readLabels(s),
    };
  } catch {
    return { ...EMPTY };
  }
}

function save(p: Persisted) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch {}
}

/** The stored labels, with 1.16.0's `review` flags folded in: a flag set to
 *  true adds the code review label, false takes a built-in's default one
 *  away. An explicit `labels` entry wins over the flag for the same id. */
function readLabels(s: Partial<Persisted> & { review?: unknown }): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (s.review && typeof s.review === "object" && !Array.isArray(s.review)) {
    for (const [id, on] of Object.entries(s.review as Record<string, unknown>)) {
      if (typeof on !== "boolean") continue;
      const base = (DEFAULT_LABELS[id] ?? []).filter(l => l !== CODE_REVIEW_LABEL);
      out[id] = on ? [...base, CODE_REVIEW_LABEL] : base;
    }
  }
  if (s.labels && typeof s.labels === "object" && !Array.isArray(s.labels)) {
    for (const [id, list] of Object.entries(s.labels)) {
      if (Array.isArray(list)) out[id] = cleanLabels(list.filter((l): l is string => typeof l === "string"));
    }
  }
  return out;
}

function cleanLabels(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const l = normalizeLabel(raw);
    if (l && !out.some(x => sameLabel(x, l))) out.push(l);
  }
  return out;
}

function labelsOf(p: Persisted, id: string): string[] {
  return p.labels[id] ?? [...(DEFAULT_LABELS[id] ?? [])];
}

/** Resolve the persisted delta into the ordered list the UI / dropdown use. */
function computePrompts(p: Persisted): Prompt[] {
  const items: Prompt[] = [];
  for (const d of DEFAULT_PROMPTS) {
    if (p.deletedBuiltins.includes(d.id)) continue;
    const ov = p.overrides[d.id];
    items.push({
      id: d.id,
      title: ov?.title ?? d.title,
      body: ov?.body ?? d.body,
      builtin: true,
      enabled: !p.disabled.includes(d.id),
      modified: !!ov,
      labels: labelsOf(p, d.id),
      forReview: labelsOf(p, d.id).includes(CODE_REVIEW_LABEL),
    });
  }
  for (const c of p.customs) {
    items.push({
      id: c.id, title: c.title, body: c.body, builtin: false,
      enabled: !p.disabled.includes(c.id), modified: false,
      labels: labelsOf(p, c.id),
      forReview: labelsOf(p, c.id).includes(CODE_REVIEW_LABEL),
    });
  }
  // Apply explicit order; anything not listed (new built-in / freshly added)
  // keeps its natural position at the end.
  const ordered: Prompt[] = [];
  for (const id of p.order) {
    const it = items.find(x => x.id === id);
    if (it && !ordered.includes(it)) ordered.push(it);
  }
  for (const it of items) if (!ordered.includes(it)) ordered.push(it);
  return ordered;
}

interface PromptStore {
  prompts: Prompt[];
  /** Exposed so the UI can show "Restore built-in prompts" only when relevant. */
  deletedBuiltins: string[];
  addPrompt: (init?: Partial<Prompt>) => string;
  updatePrompt: (id: string, patch: Partial<Pick<Prompt, "title" | "body" | "enabled">>) => void;
  clonePrompt: (id: string) => string | null;
  deletePrompt: (id: string) => void;
  /** Built-in only: drop the override so it renders the shipped default again. */
  resetPrompt: (id: string) => void;
  toggleEnabled: (id: string) => void;
  /** Tag or untag a prompt for code review (the built-in label). */
  setForReview: (id: string, on: boolean) => void;
  /** Replace a prompt's labels (normalized, de-duplicated). */
  setLabels: (id: string, labels: readonly string[]) => void;
  addLabel: (id: string, label: string) => void;
  removeLabel: (id: string, label: string) => void;
  /** Settings > Prompts' label filter. View state, never stored: here so
   *  Review a PR can open the page on its review prompts. */
  filterLabel: string | null;
  setFilterLabel: (label: string | null) => void;
  reorderPrompts: (from: number, to: number) => void;
  /** Re-add any built-ins the user deleted. */
  restoreBuiltins: () => void;
  /** Re-read the stored library after config sync wrote it behind the
   *  store's back. Publishes (and re-renders) only when it changed. */
  reloadFromStorage: () => boolean;
}

export const usePromptLibrary = create<PromptStore>((set, get) => {
  let p = load();

  const commit = (next: Persisted) => {
    p = next;
    save(next);
    set({ prompts: computePrompts(next), deletedBuiltins: next.deletedBuiltins });
  };

  const builtinDef = (id: string) => DEFAULT_PROMPTS.find(d => d.id === id);
  const effective = (id: string): { title: string; body: string } | null => {
    const d = builtinDef(id);
    if (d) return p.overrides[id] ?? { title: d.title, body: d.body };
    const c = p.customs.find(x => x.id === id);
    return c ? { title: c.title, body: c.body } : null;
  };

  return {
    prompts: computePrompts(p),
    deletedBuiltins: p.deletedBuiltins,
    filterLabel: null,
    setFilterLabel: (label) => set({ filterLabel: label }),

    reloadFromStorage: () => {
      const next = load();
      if (JSON.stringify(next) === JSON.stringify(p)) return false;
      p = next;
      set({ prompts: computePrompts(next), deletedBuiltins: next.deletedBuiltins });
      return true;
    },

    addPrompt: (init) => {
      const id = crypto.randomUUID();
      const custom: StoredCustom = { id, title: init?.title ?? "", body: init?.body ?? "" };
      commit({ ...p, customs: [...p.customs, custom], order: [...p.order, id] });
      return id;
    },

    updatePrompt: (id, patch) => {
      let next = p;
      if (patch.enabled !== undefined) {
        const disabled = new Set(next.disabled);
        if (patch.enabled) disabled.delete(id); else disabled.add(id);
        next = { ...next, disabled: [...disabled] };
      }
      if (patch.title !== undefined || patch.body !== undefined) {
        const eff = effective(id) ?? { title: "", body: "" };
        const title = patch.title ?? eff.title;
        const body = patch.body ?? eff.body;
        const d = builtinDef(id);
        if (d) {
          const overrides = { ...next.overrides };
          // Editing a built-in back to exactly the default clears MODIFIED.
          if (title === d.title && body === d.body) delete overrides[id];
          else overrides[id] = { title, body };
          next = { ...next, overrides };
        } else {
          next = { ...next, customs: next.customs.map(c => c.id === id ? { ...c, title, body } : c) };
        }
      }
      commit(next);
    },

    clonePrompt: (id) => {
      const eff = effective(id);
      if (!eff) return null;
      const newId = crypto.randomUUID();
      // Insert right after the source in the EFFECTIVE order. p.order may be
      // empty/partial (built-ins/customs that were never reordered aren't in
      // it), so derive the full current order and splice into that — otherwise
      // a clone of a never-reordered prompt lands at the very end.
      const order = computePrompts(p).map(x => x.id);
      const at = order.indexOf(id);
      if (at >= 0) order.splice(at + 1, 0, newId); else order.push(newId);
      // The suffix is minted into storage at clone time, like a tab title:
      // a clone is a user object, so it keeps the wording of the moment.
      // A clone keeps the source's labels: copying "Review" to tweak it
      // should not drop it out of the Review a PR dialog.
      const src = labelsOf(p, id);
      const labels = src.length ? { ...p.labels, [newId]: src } : p.labels;
      commit({ ...p, customs: [...p.customs, { id: newId, title: `${eff.title}${i18n.t("backend:copySuffix")}`, body: eff.body }], order, labels });
      return newId;
    },

    deletePrompt: (id) => {
      const order = p.order.filter(x => x !== id);
      const disabled = p.disabled.filter(x => x !== id);
      const labels = { ...p.labels }; delete labels[id];
      p = { ...p, labels };
      if (builtinDef(id)) {
        const overrides = { ...p.overrides }; delete overrides[id];
        commit({ ...p, deletedBuiltins: Array.from(new Set([...p.deletedBuiltins, id])), overrides, order, disabled });
      } else {
        commit({ ...p, customs: p.customs.filter(c => c.id !== id), order, disabled });
      }
    },

    resetPrompt: (id) => {
      if (!builtinDef(id)) return;
      const overrides = { ...p.overrides }; delete overrides[id];
      commit({ ...p, overrides });
    },

    toggleEnabled: (id) => {
      const disabled = new Set(p.disabled);
      if (disabled.has(id)) disabled.delete(id); else disabled.add(id);
      commit({ ...p, disabled: [...disabled] });
    },

    reorderPrompts: (from, to) => {
      const ids = computePrompts(p).map(x => x.id);
      if (from < 0 || from >= ids.length || to < 0 || to >= ids.length || from === to) return;
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved);
      commit({ ...p, order: ids });
    },

    setLabels: (id, list) => {
      const next = cleanLabels(list);
      const def = DEFAULT_LABELS[id] ?? [];
      const labels = { ...p.labels };
      // Back to the default is stored as nothing, like an unedited built-in,
      // so a better default shipped later still reaches this prompt.
      const isDefault = next.length === def.length && next.every(l => def.some(d => sameLabel(d, l)));
      if (isDefault) delete labels[id];
      else labels[id] = next;
      commit({ ...p, labels });
    },

    addLabel: (id, label) => {
      const l = normalizeLabel(label);
      if (!l) return;
      const cur = labelsOf(p, id);
      if (cur.some(x => sameLabel(x, l))) return;
      get().setLabels(id, [...cur, l]);
    },

    removeLabel: (id, label) => {
      const cur = labelsOf(p, id);
      if (!cur.some(x => sameLabel(x, label))) return;
      get().setLabels(id, cur.filter(x => !sameLabel(x, label)));
    },

    setForReview: (id, on) => {
      if (on) get().addLabel(id, CODE_REVIEW_LABEL);
      else get().removeLabel(id, CODE_REVIEW_LABEL);
    },

    restoreBuiltins: () => {
      commit({ ...p, deletedBuiltins: [] });
    },
  };
});
