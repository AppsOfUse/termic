// Slot math runs on local wall-clock time, so the zone is pinned for this
// file. Node re-reads TZ when it changes, and vitest's default pool runs each
// file in its own process, so this does not leak into other files. The first
// test asserts the offsets took, so a runner that ignored the pin fails here
// instead of passing every DST case trivially in UTC.
process.env.TZ = "America/New_York";

import { describe, it, expect } from "vitest";
import {
  GRACE_MS, decidePass, initialLastSlot, latestSlotAtOrBefore, nextSlotAfter, parseTime,
  localDate, onceSlot, parseDate, slotOnDay, slotsBetween,
} from "@/lib/schedules/slots";
import type { ScheduleCadence, TaskSchedule } from "@/lib/types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (y: number, mo: number, d: number, h = 0, m = 0) => new Date(y, mo - 1, d, h, m).getTime();
const daily = (time = "09:00"): ScheduleCadence => ({ kind: "daily", time });
const sched = (extra: Partial<TaskSchedule> = {}): Pick<TaskSchedule, "enabled" | "cadence" | "catch_up" | "last_slot"> =>
  ({ enabled: true, cadence: daily(), catch_up: false, last_slot: null, ...extra });

describe("the pinned zone", () => {
  it("really is America/New_York, DST included", () => {
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(300);
    expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(240);
  });
});

describe("parseTime", () => {
  it("takes HH:MM and nothing else", () => {
    expect(parseTime("09:05")).toEqual({ h: 9, m: 5 });
    expect(parseTime("23:59")).toEqual({ h: 23, m: 59 });
    for (const bad of ["9:05", "24:00", "12:60", "", "09:05:00"]) expect(parseTime(bad)).toBeNull();
  });
});

describe("cadences", () => {
  // 2026-10-02 is a Friday.
  const fri = at(2026, 10, 2, 12);
  const sat = at(2026, 10, 3, 12);

  it("daily: today's slot once it has passed, else yesterday's", () => {
    expect(latestSlotAtOrBefore(daily(), fri)).toBe(at(2026, 10, 2, 9));
    expect(latestSlotAtOrBefore(daily(), at(2026, 10, 2, 8, 59))).toBe(at(2026, 10, 1, 9));
    expect(latestSlotAtOrBefore(daily(), at(2026, 10, 2, 9))).toBe(at(2026, 10, 2, 9));
    expect(nextSlotAfter(daily(), fri)).toBe(at(2026, 10, 3, 9));
  });

  it("weekdays: the weekend has no slot", () => {
    const c: ScheduleCadence = { kind: "weekdays", time: "09:00" };
    expect(latestSlotAtOrBefore(c, sat)).toBe(at(2026, 10, 2, 9));
    expect(latestSlotAtOrBefore(c, at(2026, 10, 4, 23))).toBe(at(2026, 10, 2, 9));
    expect(nextSlotAfter(c, fri)).toBe(at(2026, 10, 5, 9));
    expect(slotOnDay(c, 2026, 9, 3)).toBeNull();
  });

  it("weekly: one day a week", () => {
    const wed: ScheduleCadence = { kind: "weekly", time: "17:30", weekday: 3 };
    expect(latestSlotAtOrBefore(wed, fri)).toBe(at(2026, 9, 30, 17, 30));
    expect(nextSlotAfter(wed, fri)).toBe(at(2026, 10, 7, 17, 30));
    expect(slotsBetween(wed, at(2026, 9, 1), at(2026, 9, 30, 23))).toBe(5);
  });

  it("a broken time has no slot rather than a guess", () => {
    expect(latestSlotAtOrBefore(daily("25:00"), fri)).toBeNull();
    expect(decidePass(sched({ cadence: daily("nope") }), fri, false)).toEqual({ kind: "none" });
  });
});

describe("DST", () => {
  it("spring forward: a slot in the missing hour rolls forward, once", () => {
    // 2026-03-08 02:00 EST -> 03:00 EDT. 02:30 does not exist.
    const c = daily("02:30");
    const slot = latestSlotAtOrBefore(c, at(2026, 3, 8, 12))!;
    expect(new Date(slot).getHours()).toBe(3);
    expect(new Date(slot).getDate()).toBe(8);
    expect(slotsBetween(c, at(2026, 3, 7, 23), at(2026, 3, 8, 23))).toBe(1);
    const first = decidePass(sched({ cadence: c, last_slot: at(2026, 3, 7, 2, 30) }), slot + MIN, false);
    expect(first).toMatchObject({ kind: "fire", slot });
    expect(decidePass(sched({ cadence: c, last_slot: slot }), slot + 10 * MIN, false)).toEqual({ kind: "none" });
  });

  it("fall back: the repeated hour cannot fire twice", () => {
    // 2026-11-01 02:00 EDT -> 01:00 EST. 01:30 happens twice.
    const c = daily("01:30");
    const slot = at(2026, 11, 1, 1, 30);
    const fired = decidePass(sched({ cadence: c, last_slot: at(2026, 10, 31, 1, 30) }), slot + MIN, false);
    expect(fired).toMatchObject({ kind: "fire", slot });
    // One wall-clock hour later it is 01:30 again; the day still has one slot.
    const again = slot + HOUR;
    expect(new Date(again).getHours()).toBe(1);
    expect(new Date(again).getMinutes()).toBe(30);
    expect(decidePass(sched({ cadence: c, last_slot: slot }), again + MIN, false)).toEqual({ kind: "none" });
    expect(slotsBetween(c, at(2026, 10, 31, 12), at(2026, 11, 1, 12))).toBe(1);
  });

  it("a day is still one slot when it is 23 or 25 hours long", () => {
    expect(slotsBetween(daily(), at(2026, 3, 1), at(2026, 3, 31, 23))).toBe(31);
    expect(slotsBetween(daily(), at(2026, 11, 1), at(2026, 11, 30, 23))).toBe(30);
  });
});

describe("decidePass", () => {
  const slot = at(2026, 10, 2, 9);
  const yesterday = at(2026, 10, 1, 9);

  it("fires a slot first seen inside the grace window", () => {
    expect(decidePass(sched({ last_slot: yesterday }), slot, false))
      .toEqual({ kind: "fire", slot, catchUp: false, missedBefore: 0 });
    expect(decidePass(sched({ last_slot: yesterday }), slot + GRACE_MS, false))
      .toMatchObject({ kind: "fire", slot });
  });

  it("calls it missed one millisecond past the window", () => {
    expect(decidePass(sched({ last_slot: yesterday }), slot + GRACE_MS + 1, false))
      .toEqual({ kind: "missed", slot, count: 1 });
  });

  it("skips while the previous run is still going", () => {
    expect(decidePass(sched({ last_slot: yesterday }), slot + MIN, true))
      .toEqual({ kind: "skip", slot, missedBefore: 0 });
  });

  it("acts on a slot once: last_slot only moves forward", () => {
    expect(decidePass(sched({ last_slot: slot }), slot + MIN, false)).toEqual({ kind: "none" });
    // A clock set back still finds nothing newer than what it acted on.
    expect(decidePass(sched({ last_slot: slot }), slot - HOUR, false)).toEqual({ kind: "none" });
  });

  it("does nothing when disabled", () => {
    expect(decidePass(sched({ enabled: false, last_slot: yesterday }), slot + MIN, false)).toEqual({ kind: "none" });
  });

  it("counts a streak of missed slots as one decision", () => {
    const threeDaysAgo = at(2026, 9, 29, 9);
    expect(decidePass(sched({ last_slot: threeDaysAgo }), at(2026, 10, 2, 12), false))
      .toEqual({ kind: "missed", slot, count: 3 });
  });

  it("a Mac that slept for days and woke inside the window still gets today's run", () => {
    const threeDaysAgo = at(2026, 9, 29, 9);
    expect(decidePass(sched({ last_slot: threeDaysAgo }), slot + 3 * MIN, false))
      .toEqual({ kind: "fire", slot, catchUp: false, missedBefore: 2 });
  });

  it("catch-up fires once however many slots passed, and only when opted in", () => {
    const threeDaysAgo = at(2026, 9, 29, 9);
    const noon = at(2026, 10, 2, 12);
    expect(decidePass(sched({ last_slot: threeDaysAgo, catch_up: true }), noon, false))
      .toEqual({ kind: "fire", slot, catchUp: true, missedBefore: 2 });
    expect(decidePass(sched({ last_slot: threeDaysAgo, catch_up: true }), noon, true))
      .toEqual({ kind: "missed", slot, count: 3 });
  });

  it("a schedule created after today's slot neither fires nor misses today", () => {
    const created = at(2026, 10, 2, 10);
    const last = initialLastSlot(daily(), created);
    expect(last).toBe(slot);
    expect(decidePass(sched({ last_slot: last }), created + MIN, false)).toEqual({ kind: "none" });
    expect(decidePass(sched({ last_slot: last }), at(2026, 10, 3, 9, 1), false))
      .toMatchObject({ kind: "fire", slot: at(2026, 10, 3, 9) });
  });
});

describe("a once cadence", () => {
  const once = (date = "2026-10-27", time = "09:00"): ScheduleCadence => ({ kind: "once", time, date });
  const slot = at(2026, 10, 27, 9);

  it("reads a real calendar date and refuses one that would roll over", () => {
    expect(parseDate("2026-10-27")).toEqual({ y: 2026, mo: 9, d: 27 });
    for (const bad of ["2026-02-30", "2026-13-01", "27-10-2026", "2026-10-7", "", undefined]) {
      expect(parseDate(bad as string | undefined)).toBeNull();
    }
    expect(localDate(slot)).toBe("2026-10-27");
  });

  it("has exactly one slot, on its own day", () => {
    expect(onceSlot(once())).toBe(slot);
    expect(onceSlot({ kind: "once", time: "09:00" })).toBeNull();
    expect(slotOnDay(once(), 2026, 9, 27)).toBe(slot);
    expect(slotOnDay(once(), 2026, 9, 28)).toBeNull();
    expect(slotOnDay(once(), 2027, 9, 27)).toBeNull();
  });

  it("is found however long ago it passed, which a week-long walk would miss", () => {
    expect(latestSlotAtOrBefore(once(), slot - 1)).toBeNull();
    expect(latestSlotAtOrBefore(once(), slot)).toBe(slot);
    expect(latestSlotAtOrBefore(once(), at(2027, 6, 1))).toBe(slot);
  });

  it("has a next slot only while it is still ahead", () => {
    expect(nextSlotAfter(once(), at(2026, 10, 1))).toBe(slot);
    expect(nextSlotAfter(once(), slot)).toBeNull();
    expect(slotsBetween(once(), at(2026, 10, 1), at(2027, 1, 1))).toBe(1);
    expect(slotsBetween(once(), slot, at(2027, 1, 1))).toBe(0);
  });

  it("fires once on time, and never again", () => {
    const s = sched({ cadence: once(), last_slot: initialLastSlot(once(), at(2026, 10, 20)) });
    expect(s.last_slot).toBeNull();
    expect(decidePass(s, slot - MIN, false)).toEqual({ kind: "none" });
    expect(decidePass(s, slot + MIN, false)).toEqual({ kind: "fire", slot, catchUp: false, missedBefore: 0 });
    const done = { ...s, last_slot: slot };
    expect(decidePass(done, slot + 2 * MIN, false)).toEqual({ kind: "none" });
    expect(decidePass(done, at(2027, 3, 1), false)).toEqual({ kind: "none" });
  });

  it("a one-off the app slept through is reported missed, or caught up when opted in", () => {
    const s = sched({ cadence: once(), last_slot: null });
    const later = at(2026, 10, 29, 12);
    expect(decidePass(s, later, false)).toEqual({ kind: "missed", slot, count: 1 });
    expect(decidePass({ ...s, catch_up: true }, later, false))
      .toEqual({ kind: "fire", slot, catchUp: true, missedBefore: 0 });
    expect(decidePass({ ...s, catch_up: true }, later, true)).toEqual({ kind: "missed", slot, count: 1 });
  });

  it("a one-off created for a date that already passed is stamped as done, not fired", () => {
    const past = once("2026-10-01");
    const created = at(2026, 10, 5, 10);
    const last = initialLastSlot(past, created);
    expect(last).toBe(at(2026, 10, 1, 9));
    expect(decidePass(sched({ cadence: past, last_slot: last }), created + HOUR, false)).toEqual({ kind: "none" });
  });

  it("the slot after a spring-forward gap rolls forward like any other", () => {
    // 2027-03-14 02:30 does not exist in New York.
    const gap = once("2027-03-14", "02:30");
    expect(new Date(onceSlot(gap)!).getHours()).toBe(3);
  });

  it("does not run in a disabled schedule", () => {
    expect(decidePass(sched({ cadence: once(), enabled: false }), slot + MIN, false)).toEqual({ kind: "none" });
  });
});
