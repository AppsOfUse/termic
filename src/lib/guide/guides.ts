// Every guide the app has. A guide is a walkthrough: a set of steps that
// follows the user through one job. See types.ts and docs/guide.md.
//
// ADDING A GUIDE:
//   1. An entry here: an id and its steps.
//   2. Copy, in both locales: guide.guides.<id>.name, and
//      guide.guides.<id>.steps.<stepId>.title / .body.
//   3. Something that starts it. Either the user asks
//      (`useGuide.getState().startGuide(id)` from a button), or a component
//      offers it once, the first time its situation arises
//      (`useOfferGuide(id, condition)`).

import type { Guide } from "./types";

/** The first-run walkthrough, and only the basics: add a project, choose
 *  where the agent works, start a task, name it, read its status mark. Five
 *  cards, of which a user who just presses on sees four at most.
 *  It used to go on to the tab, the right panel, the usage chip and "now
 *  start another", and every one of those was cut: an intro that keeps
 *  talking is one people skip, and none of them was needed to get going.
 *  Started by the welcome screen's "Show me around". */
const welcome: Guide = {
  id: "welcome",
  steps: [
    {
      id: "addProject",
      anchor: "add-project",
      side: "right",
      action: true,
      when: c => c.projects === 0,
      done: c => c.projects > 0,
    },
    {
      // Above `newTask` so that it wins while the launcher menu is open (its
      // control exists only then) and yields the moment the menu closes.
      id: "taskMode",
      anchor: "task-mode",
      side: "right",
      over: true,
      extra: "taskModes",
      when: c => c.projects > 0,
      done: c => c.liveTasks > 0,
    },
    {
      // On the field where the first task is named. Above `newTask` for the
      // same reason as `taskMode`: its control exists only while the name is
      // being typed, and that is the one moment this is worth saying. The
      // name is not only a sidebar label: agents that take a session name are
      // launched with it (`name_args` in the agent registry).
      id: "nameTask",
      anchor: "task-name",
      side: "right",
      over: true,
      passive: true,
      when: c => c.projects > 0,
      done: c => c.liveTasks > 0,
    },
    {
      id: "newTask",
      // The dashed "New task" row of an empty, expanded project is the bigger
      // target; the project's "+" is always there.
      anchor: ["new-task-empty", "new-task"],
      side: "right",
      action: true,
      when: c => c.projects > 0,
      done: c => c.liveTasks > 0,
    },
    {
      // The first thing said once a task is on screen. Not "this is a tab,
      // type here": someone who just launched an agent knows what a terminal
      // is. What they cannot guess is what the mark on the row means.
      id: "taskStatus",
      anchor: "active-task-row",
      side: "right",
      extra: "workMarks",
      when: c => !!c.activeTaskId,
    },
  ],
};

export const GUIDES: readonly Guide[] = [welcome];

export const guideById = (id: string | null): Guide | undefined =>
  id === null ? undefined : GUIDES.find(g => g.id === id);
