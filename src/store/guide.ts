// What this install has seen, and which guide is running. The registries are
// lib/guide/guides.ts and lib/guide/tips.ts, the rules lib/guide/rules.ts,
// the renderer components/guide/GuideLayer.tsx; the whole module is
// docs/guide.md.
//
// Its own small store rather than fields on `ui` or `prefs`: dismissing a
// card would otherwise re-run every selector on a store the rest of the
// window subscribes to (docs/performance.md bear trap 8).
//
// localStorage, on UNSCOPED keys: "seen" is a fact about the person at this
// machine, not about a profile. Every profile window shares the origin, so a
// card dismissed in one is dismissed in all of them, and the `storage` event
// below carries that to windows already open.

import { create } from "zustand";
import { guideById } from "@/lib/guide/guides";
import { TIP_IDS } from "@/lib/guide/tips";
import { requiredStepIds, stepIds } from "@/lib/guide/rules";
import type { GuideProgress } from "@/lib/guide/types";

const LS_SEEN = "guideSeen";
const LS_SHOWN = "guideShown";
const LS_ACTIVE = "guideActive";
const LS_TIPS = "guideTipsEnabled";
const LS_USAGE = "guideUsage";
const LS_ADOPTED = "guideAdopted";

/** What this install has used, kept so a tip can be for the people who have
 *  NOT found a feature and for nobody else. On this machine only: it is never
 *  sent anywhere, and it is not the opt-in telemetry on the roadmap. It holds
 *  three facts and no history: when watching began, how many times the app
 *  has been launched since, and which features have been used at least once.
 *  An install that predates this starts from zero on its first launch with
 *  it, because nothing was recorded before. */
export interface GuideUsage {
  since: number;
  launches: number;
  used: readonly string[];
  /** When the last launch was counted. Every window counts itself at module
   *  load, and an app started with three profile windows is one launch. */
  last?: number;
}

/** Windows opening within this long of each other are one launch. */
const SAME_LAUNCH_MS = 10 * 60 * 1000;

function readUsage(): GuideUsage | null {
  try {
    const u = JSON.parse(localStorage.getItem(LS_USAGE) ?? "null");
    if (!u || typeof u.since !== "number" || typeof u.launches !== "number" || !Array.isArray(u.used)) return null;
    return {
      since: u.since, launches: u.launches,
      used: u.used.filter((v: unknown): v is string => typeof v === "string"),
      ...(typeof u.last === "number" ? { last: u.last } : {}),
    };
  } catch { return null; }
}

/** Read at module load, which is once per window launch, and count it. */
function launchUsage(): GuideUsage {
  const prev = readUsage();
  const now = Date.now();
  if (prev && prev.last !== undefined && now - prev.last < SAME_LAUNCH_MS) return prev;
  const next: GuideUsage = prev
    ? { ...prev, launches: prev.launches + 1, last: now }
    : { since: now, launches: 1, used: [], last: now };
  try { localStorage.setItem(LS_USAGE, JSON.stringify(next)); } catch { /* counted next time */ }
  return next;
}

function readList(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch { return []; }
}
/** Everything this install must not be shown again: what was dismissed, and
 *  what was SHOWN on an earlier launch whether or not anyone dismissed it. */
const readSeen = (): string[] => [...new Set([...readList(LS_SEEN), ...readList(LS_SHOWN)])];
/** The running guide, if it is one this build still has. */
const readActive = (): string | null => {
  try { return guideById(localStorage.getItem(LS_ACTIVE))?.id ?? null; } catch { return null; }
};
const readFlag = (k: string, fallback: boolean): boolean => {
  try { const v = localStorage.getItem(k); return v === null ? fallback : v === "1"; } catch { return fallback; }
};
const write = (k: string, v: string) => {
  try { localStorage.setItem(k, v); } catch { /* a card comes back, nothing worse */ }
};

/** Recorded in `seen` once a guide has been offered, so `offerGuide` offers
 *  each one a single time however often its situation recurs. */
const offered = (guideId: string) => `guide:${guideId}`;

interface GuideState extends GuideProgress {
  /** The first project/task load has landed (App sets it). */
  ready: boolean;
  /** `adoptExisting` has run. Nothing is drawn before it has: a tip shown in
   *  the moment before an existing install's tips are marked seen is exactly
   *  the card that marking exists to prevent. */
  checked: boolean;
  /** Nothing is drawn while true. The e2e binary starts this way: a card over
   *  the window on launch would sit on top of whatever a spec is driving. The
   *  guide's own spec turns it back on. */
  suppressed: boolean;
  /** Tips announced by the components that own their situation, by id, with
   *  how many controls announce each (lib/guide/useTip). */
  present: Readonly<Record<string, number>>;
  usage: GuideUsage;
  /** A feature was used. Written the first time only, so calling this from
   *  a path that runs often costs one array lookup. */
  noteUsed: (feature: string) => void;

  setReady: () => void;
  setSuppressed: (v: boolean) => void;
  announce: (tipId: string, delta: 1 | -1) => void;

  /** Dismiss one step or tip for good. */
  markSeen: (id: string) => void;
  /** End the running guide once its required steps are all seen, taking any
   *  optional step that is left with it. The layer calls this when none of
   *  those optional steps can be shown (their control is not on screen), so
   *  an optional step gets its turn when it can have one and never keeps the
   *  guide, and every tip behind it, waiting. Does nothing while a required
   *  step is unseen. */
  finishGuide: () => void;
  /** A TIP has been on screen long enough to have been read. It is recorded
   *  at once and it stays up: `seen` in THIS window is not touched, so the
   *  card does not vanish under the reader. Every later launch, and every
   *  other window, reads the record and never draws it again. This is what
   *  makes "shown once" true for someone who reads a card and walks away
   *  without pressing anything. */
  noteShown: (tipId: string) => void;

  /** Run a guide from the top, replacing any that is running. The user asked
   *  for it: the welcome screen, a "Replay" button. Its own steps become
   *  unseen again; nothing else does. */
  startGuide: (guideId: string) => void;
  /** Start a guide the FIRST time its situation arises, and never again.
   *  For a component that notices the moment a walkthrough would help. Does
   *  nothing while another guide is running, and stays available for the
   *  next time in that case. */
  offerGuide: (guideId: string) => void;
  /** End a guide, marking its steps seen: the running one, or the one named
   *  (the welcome screen skips a guide that never started). The guide and
   *  nothing else: skipping a tour is not turning tips off, and the tips are
   *  what explain a footer that says "usage n/a". */
  skipGuide: (guideId?: string) => void;

  /** Run once per install, the first time this build's tips exist on it.
   *
   *  An install that was ALREADY set up (it has been through a welcome
   *  before) gets every tip in the registry today marked seen: its user
   *  knows the waiting pill and has been looking at their usage chip for
   *  months, and a card about either is the app talking to itself. A NEW
   *  install gets nothing marked. Either way it is recorded as done, so the
   *  only tips an existing user ever meets are ones a LATER release adds,
   *  which are not in today's registry and so were never marked. No dates on
   *  tips and no version compare: "seen" is a list of ids. */
  adoptExisting: (alreadySetUp: boolean) => void;
  setTipsEnabled: (v: boolean) => void;
  /** Forget everything seen and shown, and end any running guide. The one
   *  way "seen" is ever cleared: Settings, General, "Reset all tips and
   *  tours", pressed by the user. Every tip can then show once more when its
   *  situation arises, and every guide can be offered once more. It starts
   *  nothing itself. */
  resetAll: () => void;
}

export const useGuide = create<GuideState>((set, get) => ({
  seen: readSeen(),
  activeGuide: readActive(),
  tipsEnabled: readFlag(LS_TIPS, true),
  tipsSpent: 0,
  ready: false,
  checked: false,
  suppressed: !!import.meta.env.VITE_E2E,
  present: {},
  usage: launchUsage(),

  noteUsed: (feature) => {
    const u = get().usage;
    if (u.used.includes(feature)) return;
    const usage = { ...u, used: [...u.used, feature] };
    write(LS_USAGE, JSON.stringify(usage));
    set({ usage });
  },

  setReady: () => { if (!get().ready) set({ ready: true }); },
  setSuppressed: (v) => { if (get().suppressed !== v) set({ suppressed: v }); },

  announce: (tipId, delta) => set(s => {
    const n = Math.max(0, (s.present[tipId] ?? 0) + delta);
    const present = { ...s.present };
    if (n === 0) delete present[tipId]; else present[tipId] = n;
    return { present };
  }),

  markSeen: (id) => {
    const s = get();
    if (s.seen.includes(id)) return;
    const seen = [...s.seen, id];
    // A guide is over when every step of it has been seen. Its OPTIONAL
    // steps do not hold it open for ever, though: see `finishGuide`.
    let activeGuide = s.activeGuide;
    const guide = guideById(activeGuide);
    if (guide && stepIds(guide).every(step => seen.includes(step))) {
      activeGuide = null;
      write(LS_ACTIVE, "");
    }
    write(LS_SEEN, JSON.stringify(seen));
    set({ seen, activeGuide, tipsSpent: TIP_IDS.includes(id) ? s.tipsSpent + 1 : s.tipsSpent });
  },

  finishGuide: () => {
    const s = get();
    const guide = guideById(s.activeGuide);
    if (!guide || !requiredStepIds(guide).every(id => s.seen.includes(id))) return;
    const seen = [...new Set([...s.seen, ...stepIds(guide)])];
    write(LS_SEEN, JSON.stringify(seen));
    write(LS_ACTIVE, "");
    set({ seen, activeGuide: null });
  },

  noteShown: (tipId) => {
    const shown = readList(LS_SHOWN);
    if (shown.includes(tipId)) return;
    write(LS_SHOWN, JSON.stringify([...shown, tipId]));
  },

  startGuide: (guideId) => {
    const guide = guideById(guideId);
    if (!guide) return;
    const own = stepIds(guide);
    const seen = [...new Set([...get().seen.filter(id => !own.includes(id)), offered(guideId)])];
    write(LS_SEEN, JSON.stringify(seen));
    write(LS_ACTIVE, guideId);
    set({ seen, activeGuide: guideId });
  },

  offerGuide: (guideId) => {
    const s = get();
    if (s.activeGuide !== null || s.seen.includes(offered(guideId))) return;
    get().startGuide(guideId);
  },

  skipGuide: (guideId) => {
    const s = get();
    const guide = guideById(guideId ?? s.activeGuide);
    if (!guide) return;
    const put = [...stepIds(guide), offered(guide.id)];
    const wasActive = s.activeGuide === guide.id;
    if (!wasActive && put.every(id => s.seen.includes(id))) return;
    const seen = [...new Set([...s.seen, ...put])];
    write(LS_SEEN, JSON.stringify(seen));
    if (wasActive) write(LS_ACTIVE, "");
    set({ seen, activeGuide: wasActive ? null : s.activeGuide });
  },

  adoptExisting: (alreadySetUp) => {
    let done = true;
    try { done = localStorage.getItem(LS_ADOPTED) !== null; } catch { /* treated as done: mark nothing */ }
    if (done) { if (!get().checked) set({ checked: true }); return; }
    write(LS_ADOPTED, "1");
    if (!alreadySetUp) { set({ checked: true }); return; }
    const seen = [...new Set([...get().seen, ...TIP_IDS])];
    write(LS_SEEN, JSON.stringify(seen));
    set({ seen, checked: true });
  },

  setTipsEnabled: (v) => {
    if (get().tipsEnabled === v) return;
    write(LS_TIPS, v ? "1" : "0");
    set({ tipsEnabled: v });
  },

  resetAll: () => {
    write(LS_SEEN, "[]");
    write(LS_SHOWN, "[]");
    write(LS_ACTIVE, "");
    set({ seen: [], activeGuide: null, tipsSpent: 0 });
  },
}));

// Another window dismissed a card, ended a guide or flipped the preference.
// `storage` only fires in the windows that did NOT make the write, which is
// exactly the set that needs telling.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    // LS_SHOWN too: a tip another window is showing right now is one this
    // window must not also show.
    if (e.key === LS_SEEN || e.key === LS_SHOWN) useGuide.setState({ seen: readSeen() });
    else if (e.key === LS_ACTIVE) useGuide.setState({ activeGuide: readActive() });
    else if (e.key === LS_TIPS) useGuide.setState({ tipsEnabled: readFlag(LS_TIPS, true) });
    // A feature first used in another window is used.
    else if (e.key === LS_USAGE) { const u = readUsage(); if (u) useGuide.setState({ usage: u }); }
  });
}
