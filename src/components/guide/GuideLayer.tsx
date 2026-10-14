// The coachmark: one card pointing at one control. Draws whichever step of
// the running guide, or whichever tip, lib/guide/rules.ts says is relevant
// and whose control is actually on screen. See docs/guide.md.
//
// Three properties this file exists to keep:
//
//   - It costs nothing when there is nothing to say. `GuideLayer` reads one
//     boolean, which is false unless a guide is running or a control has
//     announced a tip. The store subscriptions and the watchers all live in
//     `GuideLive`, and none of the watchers observes the whole page while a
//     card is merely on screen.
//   - It never takes focus. The card is not focusable and swallows the
//     mousedown that would move focus, so a tip appearing or being dismissed
//     leaves the caret in the terminal where it was.
//   - It never points at nothing. An anchor has to pass a hit test at its own
//     centre, which is one rule covering every way a control can be
//     unreachable: a dialog over it, the settings overlay, a list scrolled
//     away, a pane that is `display: none`.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { GitBranch, Link2, Sparkles, X } from "lucide-react";
import { useApp } from "@/store/app";
import { useGuide } from "@/store/guide";
import { anchorSelectors, candidates as relevant, hasPending, settled, type Candidate } from "@/lib/guide/rules";
import type { GuideCtx } from "@/lib/guide/types";
import { place, type Box, type Placement } from "@/lib/guide/place";
import { WorkMarkLegend } from "@/components/WorkMarkLegend";
import { cn } from "@/lib/utils";

/** The e2e window is transparent and never focused, so the "only the focused
 *  window speaks" rule would silence every spec. */
const E2E = !!import.meta.env.VITE_E2E;

/** Over the app, under a dialog's or a menu's content (z-50). Not lower: the
 *  sidebar's filter row puts controls at z-40 in the root stacking context,
 *  and at 30 its icon drew straight through a card lying over it. A card
 *  never needs to be under a dialog's backdrop, because a covered anchor
 *  fails the hit test and the card is gone before the dialog paints. */
const Z_APP = 45;
/** Over a dialog or a menu, for a tip whose anchor is inside one. */
const Z_OVER = 70;
/** How long a tip is on screen before it counts as shown. */
const SHOWN_AFTER_MS = 2500;
/** How long a TIP stays up when nobody touches it. Long enough to be read
 *  twice, short enough that an ignored card does not sit over the app for
 *  the rest of the session. Tour steps never time out: the tour is waiting
 *  on the user, not the other way round. */
const TIP_VISIBLE_MS = 20_000;

export function GuideLayer() {
  const pending = useGuide(s => !s.suppressed && hasPending(s, s.present));
  return pending ? <GuideLive /> : null;
}

/** 0, 1 or 2: the rules only ask "none", "some" and "more than one", and a
 *  capped count stops at the second live task instead of walking the list on
 *  every store write. */
function liveTaskCount(tasks: readonly { archived?: boolean }[]): number {
  let n = 0;
  for (const t of tasks) {
    if (!t.archived && ++n === 2) break;
  }
  return n;
}

function boxOf(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
}

/** The first selector that names a control the user could click right now. */
function findAnchor(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    let nodes: NodeListOf<HTMLElement>;
    try { nodes = document.querySelectorAll<HTMLElement>(sel); } catch { continue; }
    for (const el of Array.from(nodes)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit && el.contains(hit)) return el;
    }
  }
  return null;
}

interface Shown { card: Candidate; el: HTMLElement; box: Box }

const sameBox = (a: Box, b: Box) =>
  a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

function GuideLive() {
  const ready = useGuide(s => s.ready && s.checked);
  const seen = useGuide(s => s.seen);
  const activeGuide = useGuide(s => s.activeGuide);
  const tipsEnabled = useGuide(s => s.tipsEnabled);
  const tipsSpent = useGuide(s => s.tipsSpent);
  const markSeen = useGuide(s => s.markSeen);

  // The settings overlay leaves the title bar showing, so a tip anchored there
  // would pass the hit test and draw its card underneath the settings panel
  // (seen with a tip on the title bar's profile chip).
  const settingsOpen = useApp(s => !!s.view.settingsOpen);
  const projects = useApp(s => s.projects.length);
  const liveTasks = useApp(s => liveTaskCount(s.tasks));
  const activeTaskId = useApp(s => s.activeTaskId);
  const present = useGuide(s => s.present);

  const ctx = useMemo<GuideCtx>(() => ({
    ready, projects, liveTasks, activeTaskId, present,
  }), [ready, projects, liveTasks, activeTaskId, present]);
  const progress = useMemo(
    () => ({ seen, activeGuide, tipsEnabled, tipsSpent }),
    [seen, activeGuide, tipsEnabled, tipsSpent],
  );
  const candidates = useMemo(
    () => (settingsOpen ? [] : relevant(ctx, progress)),
    [ctx, progress, settingsOpen],
  );

  // A tip for something the user already does is marked seen, never drawn.
  useEffect(() => {
    for (const id of settled(ctx, progress)) markSeen(id);
  }, [ctx, progress, markSeen]);

  const [shown, setShown] = useState<Shown | null>(null);
  const live = useRef(candidates);
  live.current = candidates;
  // With Settings open `candidates` is emptied on purpose, which must not
  // read as "nothing is left".
  const settingsRef = useRef(settingsOpen);
  settingsRef.current = settingsOpen;

  const resolve = useCallback(() => {
    let next: Shown | null = null;
    // One window speaks at a time: a tip in three profile windows at once is
    // the same interruption three times.
    if (E2E || document.hasFocus()) {
      for (const card of live.current) {
        const el = findAnchor(anchorSelectors(card.pointer));
        if (el) { next = { card, el, box: boxOf(el) }; break; }
      }
    }
    setShown(prev =>
      prev && next && prev.card.pointer.id === next.card.pointer.id && prev.el === next.el && sameBox(prev.box, next.box)
        ? prev
        : next);
    // Nothing to draw, and what is left of the running guide is optional
    // steps whose controls are not in the window at all (a hidden right
    // panel, an agent with no footer chip): the guide is over. "Not in the
    // window" and not merely "covered": a dialog passing over a control must
    // not end the guide under it, so this asks whether the control EXISTS
    // with a size, not whether it can be clicked.
    if (!next && !settingsRef.current) {
      const waitingOnScreen = live.current.some(card =>
        anchorSelectors(card.pointer).some(sel =>
          Array.from(document.querySelectorAll(sel)).some(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })));
      if (!waitingOnScreen) useGuide.getState().finishGuide();
    }
  }, []);

  useEffect(() => { resolve(); }, [candidates, resolve]);

  // Keeping up with the page, without watching all of it.
  //
  // This used to be ONE MutationObserver on the whole document that re-ran
  // the lookup, a layout flush and a synchronous React flush on every DOM
  // change anywhere in the window, for as long as any card could show: every
  // keystroke in the editor, every sidebar row re-render. Three narrow
  // watchers do the same job, each on for only as long as it is needed.
  const waiting = candidates.length > 0;
  const shownEl = shown?.el ?? null;
  // A guide's step names a control that may not be rendered yet (a name
  // field, a menu's toggle). A tip never is in that position: its control
  // announces it, so it is not a candidate until the control exists.
  const hunting = waiting && !shown && candidates.some(c => c.kind === "step");

  // 1. Overlays, and the events after which things have usually moved.
  //    Dialogs, menus and popovers are portaled, so each arrives and leaves
  //    as a DIRECT child of <body>: that is the whole watch, not the subtree.
  //    It is rare, so it can afford to be handled before paint, which is what
  //    keeps a card off a dialog's backdrop for even one frame.
  useEffect(() => {
    if (!waiting) return;
    let timer = 0;
    const later = () => {
      if (timer) return;
      timer = window.setTimeout(() => { timer = 0; resolve(); }, 50);
    };
    const overlays = new MutationObserver(() => flushSync(resolve));
    overlays.observe(document.body, { childList: true });
    // <body>'s own style: a modal parks `pointer-events: none` there and
    // lifts it a beat AFTER its node is gone, and while it is set every
    // anchor fails the hit test.
    const lock = new MutationObserver(later);
    lock.observe(document.body, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", later);
    window.addEventListener("focus", later);
    window.addEventListener("blur", later);
    // The end of a press or a drag: a click that opens a row, a sidebar
    // resize. These move controls without adding or removing an overlay.
    window.addEventListener("pointerup", later);
    window.addEventListener("keyup", later);
    document.addEventListener("scroll", later, true);
    return () => {
      window.clearTimeout(timer);
      overlays.disconnect();
      lock.disconnect();
      window.removeEventListener("resize", later);
      window.removeEventListener("focus", later);
      window.removeEventListener("blur", later);
      window.removeEventListener("pointerup", later);
      window.removeEventListener("keyup", later);
      document.removeEventListener("scroll", later, true);
    };
  }, [waiting, resolve]);

  // 2. The one control a card is pointing at: its box changing, or going to
  //    nothing because it was removed or hidden.
  useEffect(() => {
    if (!shownEl || typeof ResizeObserver === "undefined") return;
    const box = new ResizeObserver(() => resolve());
    box.observe(shownEl);
    return () => box.disconnect();
  }, [shownEl, resolve]);

  // 3. Looking for a step's control that is not on the page yet. Only this
  //    one watches the subtree, only while a guide is running with nothing to
  //    show, and it is coalesced: nothing here has to beat a paint.
  useEffect(() => {
    if (!hunting) return;
    let timer = 0;
    const found = new MutationObserver(() => {
      if (timer) return;
      timer = window.setTimeout(() => { timer = 0; resolve(); }, 100);
    });
    found.observe(document.body, { childList: true, subtree: true });
    return () => { window.clearTimeout(timer); found.disconnect(); };
  }, [hunting, resolve]);

  // USING the control a card points at finishes that card, for good.
  //
  // An `action` step has no "Got it": the control is the button. So the
  // press itself has to be what ends it, and not the step's `done` rule
  // alone, which only turns true once the whole job is finished (a task
  // exists). Between the two there is a gap, and the card used to fill it by
  // looking for its control again: press "New task" on one project, the row
  // turns into the name field, and the card reappeared on the NEXT project's
  // "New task" while the user was typing a name into the first. Told to
  // press a thing, and having pressed it, they were told again somewhere
  // else. Now the press is the end of it. If they back out, the step stays
  // finished: they have been shown where it is.
  //
  // Capture phase, on the document: Radix opens a menu on pointerdown and
  // may unmount the trigger before a bubbling handler would see anything.
  // `click` as well, for a control activated from the keyboard.
  //
  // Every standalone TIP ends this way too, not only `action` steps: a tip
  // points at a control, and someone who pressed it (clicked the usage chip
  // the "nearly out" tip sits on) has acted on it. Leaving the card up over
  // the panel they just opened read as broken. Passive cards are the
  // exception, since pressing into the field they explain is not an answer.
  const usable = shown && !shown.card.pointer.passive
    && (shown.card.pointer.action || shown.card.kind === "tip") ? shown : null;
  useEffect(() => {
    if (!usable) return;
    const { el, card } = usable;
    const used = (e: Event) => {
      if (e.target instanceof Node && el.contains(e.target)) markSeen(card.pointer.id);
    };
    document.addEventListener("pointerdown", used, true);
    document.addEventListener("click", used, true);
    return () => {
      document.removeEventListener("pointerdown", used, true);
      document.removeEventListener("click", used, true);
    };
  }, [usable, markSeen]);

  if (!shown) return null;
  return <Coachmark key={shown.card.pointer.id} card={shown.card} box={shown.box} />;
}

const ARROW_AT: Record<Placement["side"], string> = {
  // The side the CARD is on, so the arrow is on the edge facing the anchor.
  right: "left-[-6px] border-b border-l",
  left: "right-[-6px] border-r border-t",
  bottom: "top-[-6px] border-l border-t",
  top: "bottom-[-6px] border-b border-r",
};

function Coachmark({ card, box }: { card: Candidate; box: Box }) {
  const { t, i18n } = useTranslation("chrome");
  const markSeen = useGuide(s => s.markSeen);
  const skipGuide = useGuide(s => s.skipGuide);
  const tip = card.pointer;
  // A step belongs to a guide, which names it and can be skipped as a whole.
  // A tip stands alone. That is the only difference the card knows about.
  const guide = card.kind === "step" ? card.guide : null;
  const copy = guide ? `guide.guides.${guide.id}.steps.${tip.id}` : `guide.tips.${tip.id}`;
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Placement | null>(null);

  // Measured before paint, so the card is never drawn in the wrong place for
  // a frame. Re-measured when the language changes: the copy, and so the
  // card's height, changes with it.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const next = place(
      box,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      tip.side,
    );
    setPos(prev =>
      prev && prev.side === next.side && prev.left === next.left && prev.top === next.top && prev.arrow === next.arrow
        ? prev
        : next);
  }, [box, tip.side, i18n.language]);

  // Native listeners, not React props: both have to run before the event
  // reaches `document`, where Radix decides a press outside a menu or dialog
  // dismisses it. Without the first, clicking "Got it" on a tip that points
  // into the New task menu would close the menu. The second keeps focus where
  // it was, which is usually a terminal.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    const keepFocus = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
    el.addEventListener("pointerdown", stop);
    el.addEventListener("mousedown", keepFocus);
    return () => {
      el.removeEventListener("pointerdown", stop);
      el.removeEventListener("mousedown", keepFocus);
    };
  }, []);

  const z = tip.over ? Z_OVER : Z_APP;
  const tour = guide !== null;
  // "2/5": where this card sits in its guide, counted over every step it
  // declares. A step settled without being drawn (the user already had a
  // project) still counts, so the number says how much is left, honestly.
  const stepNo = guide ? guide.steps.findIndex(s => s.id === tip.id) + 1 : 0;

  // A tip is shown ONCE, and "shown" is what counts, not "dismissed":
  // someone who reads the card and walks off without pressing anything has
  // seen it. Recorded after it has been up long enough to be read, so a card
  // that a dialog covered a moment after it appeared is not spent unseen.
  // A guide's step is different: it stays until the thing it asks for is done.
  const noteShown = useGuide(s => s.noteShown);
  const placed = pos !== null;
  const noted = useRef(false);
  useEffect(() => {
    if (tour || !placed) return;
    const timer = window.setTimeout(() => { noted.current = true; noteShown(tip.id); }, SHOWN_AFTER_MS);
    // Ignored long enough: it has been read or it never will be. Seen, so it
    // does not come back the next time its situation holds.
    const expire = window.setTimeout(() => useGuide.getState().markSeen(tip.id), TIP_VISIBLE_MS);
    return () => { window.clearTimeout(timer); window.clearTimeout(expire); };
  }, [tour, placed, tip.id, noteShown]);
  // And once a tip that HAS been shown leaves the screen, for whatever
  // reason, it is seen in this window too. Without this the record above
  // only protected the next launch: "An agent is waiting on you, click to
  // jump to it", the user clicks the pill as told, the pill and the card go,
  // and the next agent to finish elsewhere brought the same card straight
  // back. Doing what a tip says must end it, and so must it scrolling away.
  // This is also what makes "one per launch" true for a tip nobody dismissed.
  useEffect(() => () => {
    if (noted.current) useGuide.getState().markSeen(tip.id);
  }, [tip.id]);
  const vertical = pos?.side === "left" || pos?.side === "right";

  return createPortal(
    <>
      <div
        aria-hidden
        data-testid="guide-ring"
        className="termic-guide-ring pointer-events-none fixed rounded-md"
        style={{ left: box.left - 3, top: box.top - 3, width: box.width + 6, height: box.height + 6, zIndex: z }}
      />
      <div
        ref={cardRef}
        role="note"
        data-guide-layer
        data-testid="guide-tip"
        data-tip-id={tip.id}
        data-guide-id={guide?.id}
        data-side={pos?.side}
        className={cn(
          "fixed w-[292px] rounded-lg border border-[var(--color-accent)] bg-[var(--color-bg-2)] p-3 text-left shadow-2xl",
          pos ? "animate-in fade-in-0" : "opacity-0",
        )}
        // `pointer-events: auto` by hand: a modal dialog or menu parks
        // `pointer-events: none` on <body>, which this card would inherit.
        style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, zIndex: z, pointerEvents: "auto" }}
      >
        {pos && (
          <span
            aria-hidden
            className={cn(
              "absolute h-[11px] w-[11px] rotate-45 border-[var(--color-accent)] bg-[var(--color-bg-2)]",
              ARROW_AT[pos.side],
            )}
            style={vertical ? { top: pos.arrow - 6 } : { left: pos.arrow - 6 }}
          />
        )}
        <button
          type="button"
          tabIndex={-1}
          data-testid="guide-tip-close"
          aria-label={t("common:dismiss")}
          onClick={() => markSeen(tip.id)}
          className="absolute right-1.5 top-1.5 rounded p-1 text-[var(--color-fg-faint)] hover:bg-[var(--color-hover)] hover:text-[var(--color-fg)]"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <div className="mb-1 flex items-center gap-1 pr-6 text-[11px] font-semibold text-[var(--color-accent)]">
          {!tour && <Sparkles className="h-3.5 w-3.5 shrink-0" />}
          {guide ? t(`guide.guides.${guide.id}.name`) : t("guide.tipEyebrow")}
          {guide && stepNo > 0 && (
            <span data-testid="guide-step-count" className="ml-auto font-normal tabular-nums text-[var(--color-fg-faint)]">
              {t("guide.stepCount", { n: stepNo, total: guide.steps.length })}
            </span>
          )}
        </div>
        <div className="text-[13.5px] font-semibold leading-snug text-[var(--color-fg)]">
          {t(`${copy}.title`)}
        </div>
        {tip.extra === "taskModes" ? (
          // Two choices, two boxes, the same icons and names as the toggle
          // the card points at. One paragraph covering both was unreadable.
          <div className="mt-2 flex flex-col gap-1.5">
            {([
              [Link2, t("dialogs:newTask.mainCheckout"), t(`${copy}.main`)],
              [GitBranch, t("dialogs:newTask.worktree"), t(`${copy}.worktree`)],
            ] as const).map(([Icon, label, line]) => (
              <div key={label} className="flex items-start gap-2 rounded-md border border-[var(--color-border-soft)] bg-[var(--color-bg)] px-2.5 py-2">
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium leading-tight text-[var(--color-fg)]">{label}</div>
                  <div className="mt-0.5 text-[12px] leading-snug text-[var(--color-fg-dim)]">{line}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-[12.5px] leading-snug text-[var(--color-fg-dim)]">
            {t(`${copy}.body`)}
          </p>
        )}
        {tip.extra === "workMarks" && <WorkMarkLegend compact className="mt-2.5" />}
        <div className="mt-3 flex items-center justify-between gap-2">
          {tour ? (
            <button
              type="button"
              tabIndex={-1}
              data-testid="guide-skip-tour"
              onClick={() => skipGuide()}
              className="text-[12px] text-[var(--color-fg-faint)] hover:text-[var(--color-fg)] hover:underline"
            >
              {t("guide.skipGuide")}
            </button>
          ) : <span />}
          {/* On every card, action and passive steps included: someone who
              has read it can always make it go away. mousedown is cancelled
              so pressing it never takes the caret out of a field the card
              points at (the passive "name the task" step is said while
              typing). */}
          <button
              type="button"
              tabIndex={-1}
              data-testid="guide-tip-ok"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => markSeen(tip.id)}
              className="rounded-md bg-[var(--color-accent-deep)] px-2.5 py-1 text-[12px] font-medium text-white hover:brightness-110"
            >
              {t("guide.gotIt")}
            </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
