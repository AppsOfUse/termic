// Every tip the app has. A tip is one situation, shown once. See types.ts
// and docs/guide.md.
//
// ADDING A TIP is three lines in three files:
//
//   1. In the component, where the situation is already known:
//        const tip = useTip(visible && atLimit && "addCredentials");
//        <button data-guide={tip} ... />
//   2. Here:   { id: "addCredentials", side: "top" },
//   3. Copy:   guide.tips.addCredentials.title / .body, in both locales.
//
// The component decides WHEN, because it is the only thing that knows. This
// list decides the order between tips that are true at once, and what a tip
// waits for (`after`). The store remembers that it was shown, so it never is
// again. A tip is not the place to promote a feature for its own sake: it is
// for the moment a control becomes the answer to what the user is looking at.

import type { Tip } from "./types";

/** Tips one launch may spend. One: a launch that greets you with a row of
 *  cards teaches you to dismiss cards, and then the one that mattered goes
 *  with the rest. The next waits for the next launch. */
export const TIPS_PER_LAUNCH = 1;

/** In order of precedence. */
export const TIPS: readonly Tip[] = [
  // An agent has been waiting for a couple of seconds in a task the user is
  // not looking at. First, because it is the only tip about something
  // happening right now. The pill decides when (WaitingAgentsPill.tsx).
  { id: "agentWaiting", side: "bottom" },
  // The agent has stopped and the task has changed files: where to look at
  // them. The intro ends at "watch the mark", and this is the step after,
  // said when it is true instead of in advance. The right panel decides when.
  { id: "reviewChanges", side: "bottom" },
  // The command palette, for someone who has had the app a few days and
  // never opened it. Everything the intro does not mention is in there.
  { id: "commandPalette", side: "bottom" },

  // All three are about the task footer's agent chip, which calls `useTip`
  // with whichever is true of it (AgentChip.tsx), so they are mutually
  // exclusive on any one chip. None fires on a chip that is simply working:
  // someone reading their numbers there already knows what it is.

  // A custom Claude status line owns the slot termic reads from.
  { id: "statusLine", side: "top" },
  // "Usage unknown", and the reason is that the agent has no hooks.
  { id: "agentHooks", side: "top" },
  // The session or weekly window is at its limit and there is no second
  // login to switch to: the one moment "you can add another" is news.
  { id: "addCredentials", side: "top" },
];

export const TIP_IDS: readonly string[] = TIPS.map(t => t.id);
