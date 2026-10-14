// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { useGuide } from "./guide";
import { guideById } from "@/lib/guide/guides";
import { TIP_IDS } from "@/lib/guide/tips";
import { requiredStepIds, stepIds } from "@/lib/guide/rules";

const stored = (key = "guideSeen") => JSON.parse(localStorage.getItem(key) ?? "[]") as string[];
const welcome = guideById("welcome")!;
const STEPS = stepIds(welcome);
/** `seen` without the "this guide was offered" markers. */
const cards = () => useGuide.getState().seen.filter(id => !id.startsWith("guide:")).sort();

describe("guide store", () => {
  beforeEach(() => {
    localStorage.clear();
    useGuide.setState({ seen: [], activeGuide: null, tipsEnabled: true, tipsSpent: 0, present: {}, checked: false, usage: { since: 0, launches: 1, used: [] } });
  });

  it("a dismissal is permanent: it is written", () => {
    useGuide.getState().markSeen("addProject");
    expect(stored()).toEqual(["addProject"]);
  });

  it("writes nothing when it was already seen", () => {
    useGuide.getState().markSeen("addProject");
    const before = useGuide.getState().seen;
    useGuide.getState().markSeen("addProject");
    expect(useGuide.getState().seen).toBe(before);
  });

  it("counts a dismissed tip against this launch, and a guide's step not at all", () => {
    useGuide.getState().startGuide("welcome");
    useGuide.getState().markSeen("addProject");
    expect(useGuide.getState().tipsSpent).toBe(0);
    useGuide.getState().markSeen("statusLine");
    expect(useGuide.getState().tipsSpent).toBe(1);
  });

  it("ends a guide when its last step is seen, with no separate finish", () => {
    useGuide.getState().startGuide("welcome");
    for (const id of STEPS) {
      expect(useGuide.getState().activeGuide).toBe("welcome");
      useGuide.getState().markSeen(id);
    }
    expect(useGuide.getState().activeGuide).toBe(null);
    expect(localStorage.getItem("guideActive")).toBe("");
    expect(cards()).toEqual([...STEPS].sort());
  });

  it("cannot be finished early while a required step is unseen", () => {
    useGuide.getState().startGuide("welcome");
    useGuide.getState().markSeen(requiredStepIds(welcome)[0]);
    useGuide.getState().finishGuide();
    expect(useGuide.getState().activeGuide).toBe("welcome");
  });

  it("skipping the tour skips the tour and nothing else: the tips stay armed", () => {
    useGuide.getState().startGuide("welcome");
    useGuide.getState().skipGuide();
    expect(useGuide.getState().activeGuide).toBe(null);
    expect(cards()).toEqual([...STEPS].sort());
    expect(TIP_IDS.some(id => useGuide.getState().seen.includes(id))).toBe(false);
  });

  it("can skip a guide that never started, which is what the welcome screen's Skip does", () => {
    useGuide.getState().skipGuide("welcome");
    expect(useGuide.getState().activeGuide).toBe(null);
    expect(cards()).toEqual([...STEPS].sort());
  });

  it("taking the tour leaves the tips armed for the day one applies", () => {
    useGuide.getState().startGuide("welcome");
    expect(TIP_IDS.some(id => useGuide.getState().seen.includes(id))).toBe(false);
  });

  it("a replay brings the guide's own steps back and nothing else", () => {
    useGuide.getState().markSeen("statusLine");
    useGuide.getState().skipGuide("welcome");
    useGuide.getState().startGuide("welcome");
    expect(useGuide.getState().activeGuide).toBe("welcome");
    // A tip that was seen stays seen.
    expect(cards()).toEqual(["statusLine"]);
  });

  it("an install that was already set up has today's tips marked seen, once", () => {
    useGuide.getState().adoptExisting(true);
    expect(cards()).toEqual([...TIP_IDS].sort());
    expect(useGuide.getState().checked).toBe(true);
    // The tour is not touched: it only ever starts when asked for.
    expect(STEPS.some(id => useGuide.getState().seen.includes(id))).toBe(false);
    // Once per install. After a reset the user asked for, the next launch
    // must not quietly mark everything seen again.
    useGuide.getState().resetAll();
    useGuide.getState().adoptExisting(true);
    expect(useGuide.getState().seen).toEqual([]);
  });

  it("a new install has nothing marked, and is not adopted later either", () => {
    useGuide.getState().adoptExisting(false);
    expect(useGuide.getState().seen).toEqual([]);
    expect(useGuide.getState().checked).toBe(true);
    // Next launch it HAS been through the welcome. It is still a new install.
    useGuide.getState().adoptExisting(true);
    expect(useGuide.getState().seen).toEqual([]);
  });

  it("offers a guide once: the first time its situation arises, and never after a skip", () => {
    useGuide.getState().offerGuide("welcome");
    expect(useGuide.getState().activeGuide).toBe("welcome");
    useGuide.getState().skipGuide();
    // The situation comes round again. The user already said no.
    useGuide.getState().offerGuide("welcome");
    expect(useGuide.getState().activeGuide).toBe(null);
  });

  it("does not offer a guide over one that is running, and can offer it later", () => {
    useGuide.setState({ activeGuide: "somethingElse" });
    useGuide.getState().offerGuide("welcome");
    expect(useGuide.getState().activeGuide).toBe("somethingElse");
    useGuide.setState({ activeGuide: null });
    useGuide.getState().offerGuide("welcome");
    expect(useGuide.getState().activeGuide).toBe("welcome");
  });

  it("ignores a guide this build does not have", () => {
    useGuide.getState().startGuide("removedLastYear");
    expect(useGuide.getState().activeGuide).toBe(null);
  });

  it("a reset, which only Settings does, forgets everything and starts nothing", () => {
    useGuide.getState().startGuide("welcome");
    useGuide.getState().skipGuide();
    useGuide.getState().noteShown("addCredentials");
    useGuide.setState({ tipsSpent: 1 });
    useGuide.getState().resetAll();
    const s = useGuide.getState();
    expect(s.seen).toEqual([]);
    expect(s.activeGuide).toBe(null);
    expect(s.tipsSpent).toBe(0);
    expect(stored()).toEqual([]);
    expect(stored("guideShown")).toEqual([]);
    // And a guide the user skipped can be offered once more.
    useGuide.getState().offerGuide("welcome");
    expect(useGuide.getState().activeGuide).toBe("welcome");
  });

  it("a tip that was SHOWN is remembered without being dismissed, and stays up meanwhile", () => {
    useGuide.getState().noteShown("addCredentials");
    // This window: untouched, so the card the user is reading does not vanish.
    expect(useGuide.getState().seen).toEqual([]);
    expect(stored("guideShown")).toEqual(["addCredentials"]);
    // Another window, told by the storage event: already seen there.
    window.dispatchEvent(new StorageEvent("storage", { key: "guideShown" }));
    expect(useGuide.getState().seen).toEqual(["addCredentials"]);
  });

  it("a replay does not bring a shown or dismissed tip back", () => {
    useGuide.getState().markSeen("statusLine");
    useGuide.getState().noteShown("addCredentials");
    useGuide.getState().startGuide("welcome");
    expect(useGuide.getState().seen).toContain("statusLine");
    expect(stored("guideShown")).toEqual(["addCredentials"]);
  });

  it("records a feature's first use once, and keeps the record through a reset", () => {
    useGuide.getState().noteUsed("command-palette");
    const after = useGuide.getState().usage;
    expect(after.used).toEqual(["command-palette"]);
    expect(JSON.parse(localStorage.getItem("guideUsage")!).used).toEqual(["command-palette"]);
    // A second use writes nothing: this is called from paths that run often.
    useGuide.getState().noteUsed("command-palette");
    expect(useGuide.getState().usage).toBe(after);
    // Resetting the tips forgets what was SHOWN, not what was used: a tip for
    // the unused must not come back for something the user does use.
    useGuide.getState().resetAll();
    expect(useGuide.getState().usage.used).toEqual(["command-palette"]);
  });

  it("hears a first use made in another window", () => {
    localStorage.setItem("guideUsage", JSON.stringify({ since: 5, launches: 4, used: ["command-palette"] }));
    window.dispatchEvent(new StorageEvent("storage", { key: "guideUsage" }));
    expect(useGuide.getState().usage).toEqual({ since: 5, launches: 4, used: ["command-palette"] });
  });

  it("counts announced tips, and forgets one when its last control goes", () => {
    const { announce } = useGuide.getState();
    announce("addCredentials", 1);
    announce("addCredentials", 1);
    announce("addCredentials", -1);
    expect(useGuide.getState().present).toEqual({ addCredentials: 1 });
    announce("addCredentials", -1);
    expect(useGuide.getState().present).toEqual({});
  });

  it("hears a dismissal made in another window", () => {
    localStorage.setItem("guideSeen", JSON.stringify(["taskStatus"]));
    window.dispatchEvent(new StorageEvent("storage", { key: "guideSeen" }));
    expect(useGuide.getState().seen).toEqual(["taskStatus"]);
  });
});
