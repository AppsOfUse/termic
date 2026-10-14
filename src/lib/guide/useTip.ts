// The one call a component makes to show a tip for a situation, once.
//
//   const tip = useTip(atLimit && "addCredentials");
//   return <button data-guide={tip} ... />;
//
// Pass the tip's id while its situation holds and the control is on screen,
// and a falsy value otherwise. The return value goes on the element the card
// should point at. That is the whole integration: the registry entry
// (lib/guide/tips.ts) and the copy are the other two lines, and "only once"
// is not this component's business. The store remembers that it was shown.
//
// Two things the caller owes it:
//
//   - VISIBLE, not just mounted. Every visited task stays mounted, so a
//     control in a hidden task must pass a falsy id (`visible && cond && id`),
//     or it arms the layer for a card nobody could see.
//   - One id per call. A control that can be in several situations picks the
//     one that is true (`a ? "tipA" : b ? "tipB" : null`), which is also what
//     makes those tips mutually exclusive.
//
// Why announce at all, when the layer could look for `data-guide` in the DOM:
// looking means watching the DOM while it waits, and a tip about a rare
// situation would keep that watch running for every user, for ever. An
// announced tip costs nothing until its component says it is time.

import { useEffect, useState } from "react";
import { useGuide } from "@/store/guide";

export function useTip(id: string | null | undefined | false): string | undefined {
  const name = id || undefined;
  useEffect(() => {
    if (!name) return;
    const { announce } = useGuide.getState();
    announce(name, 1);
    return () => announce(name, -1);
  }, [name]);
  return name;
}

/** True once `condition` has held, without a break, for `ms`. For a tip
 *  about something that has to LAST to be worth a card:
 *
 *    const tip = useTip(useHeld(waitingElsewhere, 2500) && "agentWaiting");
 *
 *  An agent that is waiting for a blink while you switch tasks is not news;
 *  one still waiting two seconds later is. Goes false the moment the
 *  condition does, and the wait starts over. One timer per change of the
 *  condition, nothing polled. */
export function useHeld(condition: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!condition) { setHeld(false); return; }
    const timer = window.setTimeout(() => setHeld(true), ms);
    return () => window.clearTimeout(timer);
  }, [condition, ms]);
  return condition && held;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** True for someone who has had the app a while and has never used
 *  `feature`. For a tip that should reach the people who have not found a
 *  thing, and nobody else:
 *
 *    const tip = useTip(useUnused("command-palette", { days: 3, launches: 3 }) && "commandPalette");
 *
 *  Both thresholds have to pass: three calendar days alone would fire on the
 *  second session of someone who installed on Friday and came back Monday.
 *  The other half is one line where the feature runs:
 *  `useGuide.getState().noteUsed("command-palette")`. The record is local to
 *  this machine (store/guide.ts, `GuideUsage`). */
export function useUnused(feature: string, after: { days: number; launches: number }): boolean {
  return useGuide(s =>
    !s.usage.used.includes(feature)
    && s.usage.launches >= after.launches
    && Date.now() - s.usage.since >= after.days * DAY_MS);
}

/** `data-guide` for a control that has a name of its own AND may carry a
 *  tip: `data-guide={guideNames("its-name", tip)}`. The layer matches
 *  either (`~=`). */
export function guideNames(...names: (string | null | undefined | false)[]): string | undefined {
  const out = names.filter(Boolean).join(" ");
  return out || undefined;
}

/** Start a guide the first time its situation arises, and never again:
 *
 *    useOfferGuide("firstPr", visible && hasDiff && !hasPr);
 *
 *  The guide's steps then point at controls as usual. Offered once per
 *  install however often the situation recurs; a user who skips it is not
 *  asked twice. See `offerGuide` in store/guide.ts. */
export function useOfferGuide(guideId: string, when: boolean): void {
  useEffect(() => {
    if (when) useGuide.getState().offerGuide(guideId);
  }, [guideId, when]);
}
