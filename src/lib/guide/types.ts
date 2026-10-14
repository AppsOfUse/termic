// The vocabulary of the guide module (docs/guide.md).
//
// Two things draw the same card and are otherwise separate concepts, with
// separate registries, so that either can grow without the other:
//
//   - a TIP    one situation, shown once. Stands alone. `tips.ts`.
//   - a GUIDE  a named walkthrough made of STEPS, started on purpose (the
//              welcome screen starts "welcome") or offered once when some
//              situation first arises. Several can exist; one runs at a
//              time. `guides.ts`.
//
// What they share is a `Pointer`: where the card goes and when it is
// relevant. Everything here is data and pure rules (`rules.ts`), so none of
// it needs a DOM to test.

export type Side = "top" | "right" | "bottom" | "left";

/** The facts a pointer's rules may read. Small and cheap on purpose: the
 *  layer subscribes to exactly these, and a slice of a store would re-render
 *  it on every write (docs/performance.md bear trap 5). */
export interface GuideCtx {
  /** False until the first project/task load lands. Every rule is off before
   *  it: an empty store at boot looks exactly like a new install. */
  ready: boolean;
  projects: number;
  /** Tasks that are not archived, capped at 2 (none, one, several). */
  liveTasks: number;
  activeTaskId: string | null;
  /** Tips a VISIBLE component has announced with `useTip`, by id, with how
   *  many controls are announcing each. */
  present: Readonly<Record<string, number>>;
}

/** Where a card goes and when. The part a tip and a step have in common. */
export interface Pointer {
  /** Unique across every guide and every tip: it is the "seen" key. */
  id: string;
  side: Side;
  /** Others that must have been SEEN before this one may show. A hard
   *  dependency; position in the list only breaks ties. */
  after?: readonly string[];
  /** Relevant right now. Omitted: whenever the control is on screen. */
  when?: (ctx: GuideCtx) => boolean;
  /** The user already does this, so it is marked seen without being drawn. */
  done?: (ctx: GuideCtx) => boolean;
  /** Satisfied by USING the control (it still has "Got it", like every
   *  card, for someone who read it and does not want to act now). The first
   *  press on the control marks it seen, for good: someone told to press a
   *  thing, who then pressed it, is never told again, even if they back out
   *  of what it opened. `done` is still worth writing beside it, for the
   *  user who gets the job done some other way before the card is drawn. */
  action?: boolean;
  /** Said while the user is busy WITH the control (typing into the field it
   *  points at). Not ended by a press on the control, because clicking into
   *  the field is not an answer; its "Got it" keeps the caret where it is. It ends when its `done` turns true or the
   *  control goes away. */
  passive?: boolean;
  /** The control is inside a menu or a dialog: the card sits above that
   *  layer instead of under it. */
  over?: boolean;
  /** A named block drawn under the title. `taskModes` REPLACES the body: two
   *  things being told apart read as two boxed rows, not as one paragraph
   *  with a colon in the middle. */
  extra?: "workMarks" | "taskModes";
}

/** One step of a guide. It points at a control that is there to be pointed
 *  at, so it names it. */
export interface Step extends Pointer {
  /** The `data-guide` name of the control, or several in order of
   *  preference. A name on many elements (one per task, one per project)
   *  resolves to the first VISIBLE one. */
  anchor: string | readonly string[];
  /** The guide may end without this step. For a control that is not there
   *  for everybody (a hidden panel, an agent with no footer chip): a guide
   *  that waits on one never ends, and tips wait for the guide. An optional
   *  step still gets its turn when its control is on screen; the guide ends
   *  once the required steps are seen and no optional one can be shown. */
  optional?: boolean;
}

export interface Guide {
  id: string;
  /** In order of precedence: the first relevant step whose control is on
   *  screen is the one shown. Not a script. Each step has its own `when`, so
   *  a guide follows what the user does. */
  steps: readonly Step[];
}

/** A tip: one situation, shown once. Its control says when with `useTip`. */
export interface Tip extends Pointer {
  /** Defaults to the tip's own id, which is what `useTip(id)` puts on the
   *  control. */
  anchor?: string | readonly string[];
  /** Wait for the control to ANNOUNCE the tip (`useTip`). The default, and
   *  why a tip costs nothing while it waits: the layer does not watch the DOM
   *  for a situation most users never reach. `false` only for a tip about a
   *  control that is always there, which then needs a `when`. */
  announced?: boolean;
}

/** What the store knows. */
export interface GuideProgress {
  /** Ids of steps and tips this install must not be shown again. */
  seen: readonly string[];
  /** The guide that is running, if any. */
  activeGuide: string | null;
  /** The "Show tips" preference. Does not gate a guide, which the user
   *  started on purpose. */
  tipsEnabled: boolean;
  /** Tips already dismissed since this window launched. */
  tipsSpent: number;
}
