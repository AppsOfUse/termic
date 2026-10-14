import { describe, expect, it } from "vitest";
import { place, GAP, PAD } from "./place";

const vp = { width: 1200, height: 800 };
const tip = { width: 292, height: 120 };

describe("place", () => {
  it("puts the card on the preferred side, centred on the anchor, arrow at its middle", () => {
    const a = { left: 200, top: 300, width: 24, height: 24 };
    const p = place(a, tip, vp, "right");
    expect(p).toEqual({ side: "right", left: 200 + 24 + GAP, top: 312 - 60, arrow: 60 });
  });

  it("flips to the opposite side when the preferred one runs off the window", () => {
    const a = { left: 1100, top: 300, width: 24, height: 24 };
    const p = place(a, tip, vp, "right");
    expect(p.side).toBe("left");
    expect(p.left).toBe(1100 - GAP - tip.width);
  });

  it("falls back across the axis when neither side fits", () => {
    const narrow = { width: 400, height: 800 };
    const a = { left: 180, top: 40, width: 40, height: 24 };
    expect(place(a, tip, narrow, "right").side).toBe("bottom");
  });

  it("keeps the card inside the window and still aims the arrow at the anchor", () => {
    // An anchor near the top: the card cannot centre on it, so it is clamped
    // and the arrow moves up the edge to keep pointing at the control.
    const a = { left: 200, top: 10, width: 24, height: 24 };
    const p = place(a, tip, vp, "right");
    expect(p.top).toBe(PAD);
    expect(p.arrow).toBe(22 - PAD);
  });

  it("never puts the arrow on a rounded corner", () => {
    const a = { left: 200, top: 0, width: 24, height: 4 };
    expect(place(a, tip, vp, "right").arrow).toBeGreaterThanOrEqual(14);
  });

  it("returns whole pixels (fractional offsets blur text in WKWebView)", () => {
    const a = { left: 200.4, top: 300.7, width: 23.3, height: 21.1 };
    const p = place(a, { width: 291.5, height: 119.5 }, vp, "bottom");
    for (const n of [p.left, p.top, p.arrow]) expect(Number.isInteger(n)).toBe(true);
  });

  it("stays on screen in a window smaller than the card needs", () => {
    const tiny = { width: 300, height: 200 };
    const p = place({ left: 100, top: 80, width: 40, height: 24 }, tip, tiny, "right");
    expect(p.left).toBeGreaterThanOrEqual(PAD);
    expect(p.top).toBeGreaterThanOrEqual(PAD);
  });
});
