// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { useApp, type AppState } from "@/store/app";
import { usePrefs } from "@/store/prefs";
import { waitingAttentionCount, waitingCount, waitingDoneCount, waitingElsewhere } from "./waitingAgents";

// Just the slices the selectors read: projects for order, tasks, and tabs.
function state(tabs: Record<string, unknown[]>): AppState {
  return {
    ...useApp.getState(),
    projects: [{ id: "p" }],
    tasks: Object.keys(tabs).map(id => ({ id, project_id: "p", archived: false })),
    tabs,
  } as unknown as AppState;
}
const term = (extra: object) => ({ id: Math.random().toString(36), type: "terminal", ...extra });

describe("the waiting pill's two counts", () => {
  it("counts a task once, under the mark its row draws, and the halves sum to the total", () => {
    usePrefs.setState({ settledHighlight: true });
    const s = state({
      blocked: [term({ unread: { reason: "attention" } })],
      finished: [term({ workState: "done" })],
      // Both on one task: attention wins, as it does on the row's badge.
      both: [term({ workState: "done" }), term({ unread: { reason: "attention" } })],
      idle: [term({ workState: "idle" })],
      // A done BULLET (unread.reason "done") is not "blocked on you".
      bullet: [term({ workState: "done", unread: { reason: "done" } })],
    });
    expect(waitingAttentionCount(s)).toBe(2);
    expect(waitingDoneCount(s)).toBe(2);
    expect(waitingCount(s)).toBe(waitingAttentionCount(s) + waitingDoneCount(s));
  });

  it("reads zero everywhere with the settled highlight off", () => {
    usePrefs.setState({ settledHighlight: false });
    const s = state({ blocked: [term({ unread: { reason: "attention" } })], finished: [term({ workState: "done" })] });
    expect([waitingAttentionCount(s), waitingDoneCount(s), waitingCount(s)]).toEqual([0, 0, 0]);
    usePrefs.setState({ settledHighlight: true });
  });
});

describe("waiting somewhere the user is not looking", () => {
  const withActive = (tabs: Record<string, unknown[]>, activeTaskId: string | null) =>
    ({ ...state(tabs), activeTaskId } as AppState);

  it("is true for a wait in another task, blocked or finished", () => {
    usePrefs.setState({ settledHighlight: true });
    expect(waitingElsewhere(withActive({ here: [term({})], there: [term({ unread: { reason: "attention" } })] }, "here"))).toBe(true);
    expect(waitingElsewhere(withActive({ here: [term({})], there: [term({ workState: "done" })] }, "here"))).toBe(true);
    // On the dashboard nothing is on screen, so any wait is elsewhere.
    expect(waitingElsewhere(withActive({ there: [term({ workState: "done" })] }, null))).toBe(true);
  });

  it("is false when the only wait is in the task on screen", () => {
    usePrefs.setState({ settledHighlight: true });
    expect(waitingElsewhere(withActive({ here: [term({ workState: "done" })], there: [term({})] }, "here"))).toBe(false);
  });

  it("is false when nothing waits, and with the work-done UI turned off", () => {
    usePrefs.setState({ settledHighlight: true });
    expect(waitingElsewhere(withActive({ here: [term({})], there: [term({})] }, "here"))).toBe(false);
    usePrefs.setState({ settledHighlight: false });
    expect(waitingElsewhere(withActive({ there: [term({ workState: "done" })] }, "here"))).toBe(false);
    usePrefs.setState({ settledHighlight: true });
  });
});
