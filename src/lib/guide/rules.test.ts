import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/locales/en";
import zh from "@/locales/zh-CN";
import { GUIDES, guideById } from "./guides";
import { TIPS, TIP_IDS, TIPS_PER_LAUNCH } from "./tips";
import {
  candidates, hasPending, settled, anchorSelectors, anchorNames, isAnnounced, stepIds, requiredStepIds,
  type Candidate, type Registry,
} from "./rules";
import type { Guide, GuideCtx, GuideProgress, Tip } from "./types";

const ctx = (over: Partial<GuideCtx> = {}): GuideCtx => ({
  ready: true, projects: 0, liveTasks: 0, activeTaskId: null, present: {}, ...over,
});
const progress = (over: Partial<GuideProgress> = {}): GuideProgress => ({
  seen: [], activeGuide: null, tipsEnabled: true, tipsSpent: 0, ...over,
});
const ids = (cs: Candidate[]) => cs.map(c => c.pointer.id);
const welcome = guideById("welcome")!;

describe("the welcome guide follows what the user has done", () => {
  const touring = (seen: string[] = []) => progress({ activeGuide: "welcome", seen });

  it("starts by pointing at Add project, and at nothing else", () => {
    expect(ids(candidates(ctx(), touring()))).toEqual(["addProject"]);
  });

  it("moves to starting a task once a project exists, without anyone pressing Next", () => {
    const c = ctx({ projects: 1 });
    expect(settled(c, touring())).toEqual(["addProject"]);
    // The mode step outranks the "+" step: it wins while the launcher is open
    // (its control exists) and the layer falls through to newTask otherwise.
    expect(ids(candidates(c, touring(["addProject"])))).toEqual(["taskMode", "nameTask", "newTask"]);
  });

  it("says nothing about the task until there is one on screen, then starts with its status mark", () => {
    const seen = ["addProject", "taskMode", "nameTask", "newTask"];
    expect(ids(candidates(ctx({ projects: 1, liveTasks: 1 }), touring(seen)))).toEqual([]);
    expect(ids(candidates(ctx({ projects: 1, liveTasks: 1, activeTaskId: "t1" }), touring(seen))))
      .toEqual(["taskStatus"]);
  });

  it("picks up in the middle for someone who already has a project and a task", () => {
    // A replay on a set-up install: the action steps are settled, not shown.
    const c = ctx({ projects: 3, liveTasks: 2, activeTaskId: "t1" });
    expect(settled(c, touring()).sort()).toEqual(["addProject", "nameTask", "newTask", "taskMode"]);
  });

  it("says nothing when it is not running", () => {
    expect(candidates(ctx(), progress({ tipsEnabled: false }))).toEqual([]);
  });

  it("says nothing before the first load, when an empty store looks like a new install", () => {
    expect(candidates(ctx({ ready: false }), touring())).toEqual([]);
    expect(settled(ctx({ ready: false, projects: 0 }), touring())).toEqual([]);
  });

  it("is these five cards and no more", () => {
    // The basics. A step added here is a card every new user has to get
    // past, so adding one should be a decision and not a drift.
    expect(stepIds(welcome)).toEqual(["addProject", "taskMode", "nameTask", "newTask", "taskStatus"]);
  });

  it("explains the name on the field where it is typed, without a button to reach for", () => {
    const step = welcome.steps.find(s => s.id === "nameTask")!;
    expect(step.passive).toBe(true);
    expect(step.action).toBeUndefined();
    // Over a dialog too: the full New task dialog has the same field.
    expect(step.over).toBe(true);
  });
});

describe("tips", () => {
  const set = ctx({ projects: 2, liveTasks: 2, activeTaskId: "t1" });
  const on = (...names: string[]) => ({ ...set, present: Object.fromEntries(names.map(n => [n, 1])) });

  it("say nothing to someone whose footer chip is simply working", () => {
    // A set-up install with a task open and numbers on the chip. Reading
    // them there is knowing what the chip is.
    expect(candidates(set, progress())).toEqual([]);
  });

  it("wait for the control to announce the one situation each is about", () => {
    expect(ids(candidates(on("statusLine"), progress()))).toEqual(["statusLine"]);
    expect(ids(candidates(on("agentHooks"), progress()))).toEqual(["agentHooks"]);
    expect(ids(candidates(on("addCredentials"), progress()))).toEqual(["addCredentials"]);
    expect(ids(candidates(on("agentWaiting"), progress()))).toEqual(["agentWaiting"]);
    expect(ids(candidates(on("commandPalette"), progress()))).toEqual(["commandPalette"]);
    expect(ids(candidates(on("reviewChanges"), progress()))).toEqual(["reviewChanges"]);
  });

  it("put an agent waiting right now ahead of the tips about the footer chip", () => {
    expect(ids(candidates(on("addCredentials", "agentWaiting", "statusLine"), progress()))[0]).toBe("agentWaiting");
  });

  it("are all announced, so none keeps the layer watching the DOM for a situation most users never reach", () => {
    for (const tip of TIPS) expect(isAnnounced(tip), `${tip.id} would be a standing candidate`).toBe(true);
  });

  it("need nothing but an id and a side: the control is the id, and announcing is the default", () => {
    const tip: Tip = { id: "anything", side: "top" };
    const r: Registry = { guides: [], tips: [tip] };
    expect(anchorSelectors(tip)).toEqual(['[data-guide~="anything"]']);
    expect(candidates(set, progress(), r)).toEqual([]);
    expect(ids(candidates({ ...set, present: { anything: 1 } }, progress(), r))).toEqual(["anything"]);
  });

  it("never talk over a guide, any guide", () => {
    const p = progress({ activeGuide: "welcome", seen: stepIds(welcome).filter(id => id !== "taskStatus") });
    expect(ids(candidates(on("addCredentials"), p))).toEqual(["taskStatus"]);
  });

  it("stop for this launch once one has been dismissed", () => {
    const both = on("statusLine", "addCredentials");
    const p = progress({ seen: ["statusLine"], tipsSpent: TIPS_PER_LAUNCH });
    expect(candidates(both, p)).toEqual([]);
    expect(hasPending(p, { statusLine: 1, addCredentials: 1 })).toBe(false);
    // The next launch starts the count again.
    expect(ids(candidates(both, { ...p, tipsSpent: 0 }))).toEqual(["addCredentials"]);
  });

  it("are never shown twice", () => {
    expect(candidates(on("addCredentials"), progress({ seen: ["addCredentials"] }))).toEqual([]);
  });

  it("obey the preference, which a guide does not", () => {
    expect(candidates(on("addCredentials"), progress({ tipsEnabled: false }))).toEqual([]);
    expect(hasPending(progress({ tipsEnabled: false, activeGuide: "welcome" }))).toBe(true);
  });

  it("are not shown for something the user already does, and wait for what they build on", () => {
    // No shipped tip uses `done` or `after`, so the two rules run against
    // stand-ins shaped like real entries.
    const r: Registry = { guides: [], tips: [
      { id: "a", side: "top", announced: false, done: c => c.liveTasks > 5 },
      { id: "b", side: "top", announced: false, after: ["a"] },
    ] };
    expect(ids(candidates(set, progress(), r))).toEqual(["a"]);
    expect(ids(candidates(set, progress({ seen: ["a"] }), r))).toEqual(["b"]);
    expect(settled({ ...set, liveTasks: 9 }, progress(), r)).toEqual(["a"]);
  });
});

describe("guides and tips are separate", () => {
  // A second guide, about one corner of the app, to prove nothing is welded
  // to "welcome".
  const other: Guide = { id: "other", steps: [
    { id: "o1", anchor: "x", side: "top" },
    { id: "o2", anchor: "y", side: "top", after: ["o1"] },
    { id: "o3", anchor: "z", side: "top", optional: true },
  ] };
  const tip: Tip = { id: "t1", side: "top", announced: false };
  const r: Registry = { guides: [welcome, other], tips: [tip] };
  const c = ctx({ projects: 1, liveTasks: 1, activeTaskId: "t" });

  it("a running guide shows its own steps, and no other guide's", () => {
    const got = candidates(c, progress({ activeGuide: "other" }), r);
    expect(ids(got)).toEqual(["o1", "o3"]);
    expect(got[0]).toMatchObject({ kind: "step", guide: { id: "other" } });
  });

  it("holds a step back until the step it builds on has been seen", () => {
    expect(ids(candidates(c, progress({ activeGuide: "other" }), r))).not.toContain("o2");
    expect(ids(candidates(c, progress({ activeGuide: "other", seen: ["o1"] }), r))).toEqual(["o2", "o3"]);
  });

  it("knows which steps a guide can end without", () => {
    expect(requiredStepIds(other)).toEqual(["o1", "o2"]);
    expect(stepIds(other)).toEqual(["o1", "o2", "o3"]);
  });

  it("with no guide running, only tips are candidates", () => {
    const got = candidates(c, progress(), r);
    expect(ids(got)).toEqual(["t1"]);
    expect(got[0].kind).toBe("tip");
  });

  it("a guide this build does not have is no guide at all", () => {
    expect(ids(candidates(c, progress({ activeGuide: "removedLastYear" }), r))).toEqual(["t1"]);
  });

  it("has nothing pending while no tip's control has announced it, which is the normal case", () => {
    // Tips unseen, tips on, nothing spent, no guide: every install, most of
    // the time. The layer must not be mounted for that.
    expect(hasPending(progress())).toBe(false);
    expect(hasPending(progress(), { addCredentials: 1 })).toBe(true);
    // A tip that is not waiting to be announced is always pending.
    const r: Registry = { guides: [], tips: [{ id: "x", side: "top", announced: false }] };
    expect(hasPending(progress(), {}, r)).toBe(true);
  });

  it("has nothing pending for an install that has seen it all, so the layer mounts nothing", () => {
    expect(hasPending(progress({ seen: [...GUIDES.flatMap(stepIds), ...TIP_IDS] }))).toBe(false);
  });
});

// The registries are joined to three things by string: their copy, their
// controls and what they depend on. Each fails silently at runtime (a raw key
// on screen, a card that never appears), so each is pinned here.
describe("the registries", () => {
  const at = (tree: unknown, path: string) =>
    path.split(".").reduce<unknown>((n, k) => (n as Record<string, unknown> | undefined)?.[k], tree);
  const copyPaths = [
    ...GUIDES.flatMap(g => g.steps.map(s => `chrome.guide.guides.${g.id}.steps.${s.id}`)),
    ...TIPS.map(t => `chrome.guide.tips.${t.id}`),
  ];

  it("have a title and a body for every step and tip, and a name for every guide, in both locales", () => {
    for (const [name, locale] of [["en", en], ["zh-CN", zh]] as const) {
      for (const g of GUIDES) {
        expect(typeof at(locale, `chrome.guide.guides.${g.id}.name`), `${name} guide ${g.id} has no name`).toBe("string");
      }
      for (const path of copyPaths) {
        // A step drawn as two rows carries a line per row instead of a body.
        const rows = GUIDES.some(g => g.steps.some(st => st.extra === "taskModes" && path.endsWith(`.steps.${st.id}`)));
        for (const part of rows ? ["title", "main", "worktree"] : ["title", "body"]) {
          const v = at(locale, `${path}.${part}`);
          expect(typeof v === "string" && v.length > 0, `${name} ${path}.${part}`).toBe(true);
          expect(String(v), `${name} ${path}.${part} has an em dash`).not.toContain("—");
        }
      }
    }
  });

  it("have no copy for a step or a tip that no longer exists", () => {
    const tipCopy = Object.keys(at(en, "chrome.guide.tips") as object);
    expect(tipCopy.filter(id => !TIP_IDS.includes(id))).toEqual([]);
    for (const g of Object.keys(at(en, "chrome.guide.guides") as object)) {
      const guide = guideById(g);
      expect(guide, `copy for a guide "${g}" that does not exist`).toBeDefined();
      const stale = Object.keys(at(en, `chrome.guide.guides.${g}.steps`) as object).filter(id => !stepIds(guide!).includes(id));
      expect(stale).toEqual([]);
    }
  });

  it("use ids that are unique across every guide and every tip", () => {
    // One flat "seen" list: a step and a tip sharing an id would dismiss
    // each other.
    const all = [...GUIDES.flatMap(stepIds), ...TIP_IDS];
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter(id => id.startsWith("guide:"))).toEqual([]);
  });

  it("only depend on what exists and comes earlier in the same list", () => {
    for (const list of [...GUIDES.map(g => g.steps), TIPS]) {
      const order = list.map(p => p.id);
      for (const p of list) {
        for (const dep of p.after ?? []) {
          expect(order.indexOf(dep), `${p.id} waits for unknown "${dep}"`).toBeGreaterThanOrEqual(0);
          expect(order.indexOf(dep), `${p.id} waits for "${dep}", which is listed after it`).toBeLessThan(order.indexOf(p.id));
        }
      }
    }
  });

  it("join every step and tip to a control: a data-guide name some component renders, or a useTip call", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx$/.test(name)) files.push(p);
      }
    };
    walk(join(__dirname, "..", "..", "components"));
    const sources = files.map(f => readFileSync(f, "utf8"));
    const src = sources.join("\n");
    for (const tip of TIPS) {
      if (!isAnnounced(tip)) continue;
      // Some component that calls `useTip` names this id. Not necessarily in
      // the call itself, which may pick between several.
      const owner = sources.some(text => text.includes("useTip(") && text.includes(`"${tip.id}"`));
      expect(owner, `${tip.id}: no component announces it with useTip`).toBe(true);
    }
    for (const step of GUIDES.flatMap(g => g.steps)) {
      for (const name of anchorNames(step)) {
        // `data-guide="name"`, `data-guide={cond ? "name" : undefined}`, or
        // `data-guide={guideNames("name", ...)}`.
        const found = new RegExp(`data-guide=(\\{[^}]*)?"${name}"`).test(src);
        expect(found, `${step.id}: no element carries data-guide="${name}"`).toBe(true);
      }
    }
  });
});
