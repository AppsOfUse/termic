// @vitest-environment happy-dom
//
// The sidebar tab-row drag reorders LIVE through `reorderTab`, which never
// touches tab-subgroup membership, so `onDrop` (where TaskRow commits
// membership and gathers the runs) must run on every end of a started drag:
// release, cancel, and the row unmounting mid-drag (task archived, closed by
// an agent over the CLI, its project collapsed). Driven against the real
// store with an `onDrop` that commits the way TaskRow does.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ptyWrite: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  projectsList: vi.fn().mockResolvedValue([]),
  tasksList: vi.fn().mockResolvedValue([]),
  settingsLoad: vi.fn().mockResolvedValue({ agents: [] }),
  detectClis: vi.fn().mockResolvedValue([]),
  taskSetTabs: vi.fn().mockResolvedValue(undefined),
  taskSetTabSessionId: vi.fn().mockResolvedValue(undefined),
  taskSetSplitLayout: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/tabFocus", () => ({
  focusTerminalTab: vi.fn(),
  focusMainTab: vi.fn(),
  focusPaneTab: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useApp } from "@/store/app";
import type { TabSubgroup, TerminalTab } from "@/lib/types";
import { getTabIds, getTabs, makeTask, makeTerminalTab, resetAppStore, seedTab } from "@/test-utils/store";
import { useSidebarTabDrag } from "./useSidebarTabDrag";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A: TabSubgroup = { id: "A", name: "Alpha", color: "blue" };
const ROW_H = 20;
const ORDER = ["a", "b", "x"];
const groupsOf = () => getTabs("ws1").map(t => (t as TerminalTab).subgroup?.id ?? "-").join("");

let api: ReturnType<typeof useSidebarTabDrag> | null = null;
const onDrop = vi.fn((tabId: string) => {
  const st = useApp.getState();
  const tab = (st.tabs.ws1 ?? []).find(t => t.id === tabId) as TerminalTab | undefined;
  if (!tab) return;
  st.dropTabInSubgroup("ws1", tabId, tab.subgroup ?? null);
});

function Harness() {
  api = useSidebarTabDrag("ws1", ORDER.join(" "), { onDrop });
  return createElement("div", { "data-sidebar-task-row": "" },
    ORDER.map(id => createElement("div", { key: id, "data-sidebar-tab-id": id })));
}

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  resetAppStore();
  useApp.setState({ splitTree: {}, activePaneId: {}, paneHistory: {}, collapsedTabSubgroups: {} });
  useApp.setState({ tasks: [makeTask({ id: "ws1" })] });
  for (const t of [{ id: "a", subgroup: A }, { id: "b", subgroup: A }, { id: "x" }] as Partial<TerminalTab>[]) {
    seedTab("ws1", makeTerminalTab(t));
  }
  onDrop.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => { root.render(createElement(Harness)); });
  // Rows at FIXED y slots: happy-dom does not lay out.
  ORDER.forEach((id, i) => {
    const el = host.querySelector<HTMLElement>(`[data-sidebar-tab-id="${id}"]`)!;
    el.getBoundingClientRect = () => ({
      top: i * ROW_H, bottom: (i + 1) * ROW_H, height: ROW_H, left: 0, right: 200, width: 200, x: 0, y: i * ROW_H,
      toJSON() { return {}; },
    }) as DOMRect;
  });
});

afterEach(() => {
  try { act(() => root.unmount()); } catch { /* already unmounted */ }
  host.remove();
  api = null;
});

/** Press x's row, then move into the gap between a and b. */
function liftXBetweenAAndB() {
  const row = host.querySelector<HTMLElement>(`[data-sidebar-tab-id="x"]`)!;
  act(() => {
    api!.onRowPointerDown({
      button: 0, target: row, currentTarget: row, clientX: 10, clientY: 50,
    } as unknown as React.PointerEvent, "x");
  });
  act(() => { document.dispatchEvent(new PointerEvent("pointermove", { clientX: 10, clientY: 25 })); });
}

describe("useSidebarTabDrag commits however the drag ends", () => {
  it("the live reorder alone tears the run (the state each case must repair)", () => {
    liftXBetweenAAndB();
    expect(getTabIds("ws1")).toEqual(["a", "x", "b"]);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("a cancel commits", () => {
    liftXBetweenAAndB();
    act(() => { document.dispatchEvent(new PointerEvent("pointercancel")); });
    expect(onDrop).toHaveBeenCalledWith("x");
    expect(getTabIds("ws1")).toEqual(["a", "b", "x"]);
    expect(groupsOf()).toBe("AA-");
  });

  it("an unmount mid-drag commits", () => {
    liftXBetweenAAndB();
    act(() => root.unmount());
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(getTabIds("ws1")).toEqual(["a", "b", "x"]);
    expect(groupsOf()).toBe("AA-");
  });

  it("an unmount after the task is gone commits nothing and does not throw", () => {
    liftXBetweenAAndB();
    useApp.setState(s => {
      const { ws1: _gone, ...rest } = s.tabs;
      void _gone;
      return { tabs: rest };
    });
    const before = useApp.getState();
    act(() => root.unmount());
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(useApp.getState()).toBe(before);
  });

  it("an unmount after a press that never started commits nothing", () => {
    const row = host.querySelector<HTMLElement>(`[data-sidebar-tab-id="x"]`)!;
    act(() => {
      api!.onRowPointerDown({
        button: 0, target: row, currentTarget: row, clientX: 10, clientY: 50,
      } as unknown as React.PointerEvent, "x");
    });
    act(() => root.unmount());
    expect(onDrop).not.toHaveBeenCalled();
  });
});
