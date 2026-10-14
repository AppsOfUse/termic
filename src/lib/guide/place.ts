// Where a coachmark sits relative to the control it points at. Pure geometry,
// so the flip and clamp rules are tested without a DOM (place.test.ts).

import type { Side as TipSide } from "./types";

export interface Box { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }

export interface Placement {
  side: TipSide;
  left: number;
  top: number;
  /** Offset of the arrow along the card's edge, from its left (top/bottom
   *  sides) or its top (left/right sides), aimed at the anchor's centre. */
  arrow: number;
}

/** Space between the anchor and the card. Room for the arrow. */
export const GAP = 10;
/** Closest the card comes to the window edge. */
export const PAD = 8;
/** Closest the arrow comes to a corner of the card, so it never sits on the
 *  rounded part. */
const ARROW_INSET = 14;

const OPPOSITE: Record<TipSide, TipSide> = { top: "bottom", bottom: "top", left: "right", right: "left" };
const CROSS: Record<TipSide, TipSide[]> = {
  top: ["right", "left"], bottom: ["right", "left"],
  left: ["bottom", "top"], right: ["bottom", "top"],
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function fits(side: TipSide, a: Box, tip: Size, vp: Size): boolean {
  switch (side) {
    case "right": return a.left + a.width + GAP + tip.width + PAD <= vp.width;
    case "left": return a.left - GAP - tip.width - PAD >= 0;
    case "bottom": return a.top + a.height + GAP + tip.height + PAD <= vp.height;
    case "top": return a.top - GAP - tip.height - PAD >= 0;
  }
}

/** Place `tip` beside `anchor`. The preferred side wins when the card fits
 *  there; otherwise the opposite side, then the two across. A window too
 *  small for any of them keeps the preferred side and clamps, which overlaps
 *  the anchor but stays on screen. Every number is rounded: a fractional
 *  offset blurs text in WKWebView. */
export function place(anchor: Box, tip: Size, vp: Size, prefer: TipSide): Placement {
  const side = [prefer, OPPOSITE[prefer], ...CROSS[prefer]].find(s => fits(s, anchor, tip, vp)) ?? prefer;
  const cx = anchor.left + anchor.width / 2;
  const cy = anchor.top + anchor.height / 2;
  const maxLeft = Math.max(PAD, vp.width - tip.width - PAD);
  const maxTop = Math.max(PAD, vp.height - tip.height - PAD);

  let left: number;
  let top: number;
  if (side === "left" || side === "right") {
    left = side === "right" ? anchor.left + anchor.width + GAP : anchor.left - GAP - tip.width;
    top = cy - tip.height / 2;
  } else {
    top = side === "bottom" ? anchor.top + anchor.height + GAP : anchor.top - GAP - tip.height;
    left = cx - tip.width / 2;
  }
  left = Math.round(clamp(left, PAD, maxLeft));
  top = Math.round(clamp(top, PAD, maxTop));

  const vertical = side === "left" || side === "right";
  const span = vertical ? tip.height : tip.width;
  const raw = vertical ? cy - top : cx - left;
  const arrow = Math.round(clamp(raw, Math.min(ARROW_INSET, span / 2), Math.max(span - ARROW_INSET, span / 2)));
  return { side, left, top, arrow };
}
