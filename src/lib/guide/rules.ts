// Which card, if any, is relevant right now. Pure: every function takes the
// context and the progress and returns data, so the rules are tested without
// a DOM (rules.test.ts). Finding the control and placing the card is
// components/guide/GuideLayer.tsx.

import { GUIDES, guideById } from "./guides";
import { TIPS, TIPS_PER_LAUNCH } from "./tips";
import type { Guide, GuideCtx, GuideProgress, Pointer, Step, Tip } from "./types";

/** A pointer the layer may draw, with what it belongs to. */
export type Candidate =
  | { kind: "step"; pointer: Step; guide: Guide }
  | { kind: "tip"; pointer: Tip };

export interface Registry { guides: readonly Guide[]; tips: readonly Tip[] }
const REGISTRY: Registry = { guides: GUIDES, tips: TIPS };

export const stepIds = (g: Guide): string[] => g.steps.map(s => s.id);
/** The steps whose being seen ends the guide. */
export const requiredStepIds = (g: Guide): string[] => g.steps.filter(s => !s.optional).map(s => s.id);

export const anchorNames = (p: Step | Tip): readonly string[] =>
  p.anchor === undefined ? [p.id] : typeof p.anchor === "string" ? [p.anchor] : p.anchor;

/** The selectors for a pointer's control, in order of preference. `~=` so one
 *  element can carry several names. */
export const anchorSelectors = (p: Step | Tip): string[] =>
  anchorNames(p).map(n => `[data-guide~="${n}"]`);

/** Does this tip wait to be announced by its control? */
export const isAnnounced = (tip: Tip): boolean => tip.announced ?? true;

const unseen = (p: Pointer, progress: GuideProgress): boolean =>
  !progress.seen.includes(p.id) && !p.after?.some(id => !progress.seen.includes(id));

/** Everything that could still be drawn, before asking whether it is
 *  relevant: the running guide's unseen steps, or the unseen tips. Never
 *  both: a tip does not talk over a guide. */
function live(p: GuideProgress, r: Registry): Candidate[] {
  // A guide this build no longer has is not a guide that is running.
  const guide = r.guides.find(g => g.id === p.activeGuide);
  if (guide) {
    return guide.steps.filter(s => unseen(s, p)).map(pointer => ({ kind: "step", pointer, guide }));
  }
  // Tips: the preference is on, and this launch has not spent its allowance.
  if (!p.tipsEnabled || p.tipsSpent >= TIPS_PER_LAUNCH) return [];
  return r.tips.filter(t => unseen(t, p)).map(pointer => ({ kind: "tip", pointer }));
}

/** Whether anything could be drawn at all. The layer mounts its store
 *  subscriptions only while this holds, so it has to be FALSE for the normal
 *  case: an install with tips still unseen whose situations are not
 *  happening. A tip waiting to be announced is not pending until its control
 *  has announced it (`present`). Without that every install had the layer
 *  mounted for good, because nobody ever exhausts tips like "this account is
 *  nearly out". */
export function hasPending(
  p: GuideProgress,
  present: Readonly<Record<string, number>> = {},
  r: Registry = REGISTRY,
): boolean {
  return live(p, r).some(c =>
    c.kind !== "tip" || !isAnnounced(c.pointer) || (present[c.pointer.id] ?? 0) > 0);
}

/** Ids whose reader already does the thing: to be marked seen, undrawn. */
export function settled(ctx: GuideCtx, p: GuideProgress, r: Registry = REGISTRY): string[] {
  if (!ctx.ready) return [];
  return live(p, r).filter(c => c.pointer.done?.(ctx)).map(c => c.pointer.id);
}

/** Relevant candidates, in precedence order. The layer shows the first one
 *  whose control it can find. */
export function candidates(ctx: GuideCtx, p: GuideProgress, r: Registry = REGISTRY): Candidate[] {
  if (!ctx.ready) return [];
  return live(p, r).filter(c =>
    !c.pointer.done?.(ctx)
    && (c.pointer.when?.(ctx) ?? true)
    && (c.kind !== "tip" || !isAnnounced(c.pointer) || (ctx.present[c.pointer.id] ?? 0) > 0));
}

export { guideById };
