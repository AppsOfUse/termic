# Guides and tips

Two things draw the same small card pointing at ONE control. They are
separate concepts with separate registries, so either can grow without the
other:

- A **tip** is one situation, shown once. It stands alone. "This account is at
  its limit, you can add a second login" is a tip.
- A **guide** is a named walkthrough made of **steps**. It is started on
  purpose, or offered once when its situation first arises. The first-run
  tour is the guide called `welcome`. There can be several; one runs at a
  time, and no tip talks over one.

```
src/lib/guide/types.ts     the vocabulary: Pointer, Tip, Step, Guide, GuideCtx
src/lib/guide/tips.ts      the tip registry
src/lib/guide/guides.ts    the guide registry
src/lib/guide/rules.ts     pure rules: what is relevant now (no DOM)
src/lib/guide/useTip.ts    the hooks a component calls: useTip, useOfferGuide
src/lib/guide/place.ts     where the card sits beside its control (pure geometry)
src/store/guide.ts         what has been seen, which guide is running
src/components/guide/GuideLayer.tsx   the card, the ring, finding the control
```

## Adding a tip: one situation, shown once

Three lines, in three files.

```tsx
// 1. The component, where the situation is already known.
const tip = useTip(visible && atLimit && "addCredentials");
return <button data-guide={tip} ... />;
```

```ts
// 2. src/lib/guide/tips.ts
{ id: "addCredentials", side: "top" },
```

```ts
// 3. guide.tips, in src/locales/en/chrome.ts AND src/locales/zh-CN/chrome.ts
addCredentials: { title: "...", body: "..." },
```

Who decides what:

- **The component decides WHEN.** It is the only thing that knows its own
  situation. Pass the id while the situation holds, a falsy value otherwise.
  Do not rebuild that logic in the registry.
- **The registry decides the order** between tips that are true at once (list
  position) and what a tip waits for (`after: ["otherTip"]`).
- **The store decides "once".** The component never asks whether the tip was
  shown. See "What is remembered".

Two things `useTip` needs from its caller:

- **Visible, not just mounted.** Every visited task stays mounted. A control
  in a hidden task must pass a falsy id, or it arms the layer for a card
  nobody could see.
- **One id per call.** A control that can be in several situations picks the
  one that is true (`a ? "tipA" : b ? "tipB" : null`), which is also what
  makes those tips mutually exclusive. The footer's agent chip does exactly
  this for its three.

A control that already has a `data-guide` name of its own (a guide's step
points at it) and may also carry a tip uses
`data-guide={guideNames("its-name", tip)}`; the layer matches either.

**A tip is not a place to promote a feature for its own sake.** It is for the
moment a control becomes the answer to what the user is looking at. Profiles,
the sidebar status section and "this is the usage chip" were all written as
tips and removed: none was new to, or hidden from, the person who would have
seen it.

### A situation that has to last

`useHeld(condition, ms)` is true once the condition has held without a break
for that long, and goes false the moment it stops:

```tsx
const tip = useTip(useHeld(waitingElsewhere, 2500) && "agentWaiting");
```

Use it when a blink of the situation is not news. An agent that is "waiting"
for the instant between you switching tasks should not earn a card; one still
waiting two seconds later should.

### A tip for the people who have not found a feature

`useUnused(feature, { days, launches })` is true for someone who has had the
app at least that long and has never used the feature:

```tsx
// On the control:
const tip = useTip(useUnused("command-palette", { days: 3, launches: 3 }) && "commandPalette");
// Where the feature runs, one line:
useGuide.getState().noteUsed("command-palette");
```

This is how a tip avoids telling a long-time user what they already do, with
no "new install or old?" rule: someone who opens the palette on day one never
sees the tip, and someone who has not opened it by day three does. Both
thresholds must pass, because three calendar days alone would fire on the
second session of someone who installed on Friday and came back on Monday.

The record behind it (`GuideUsage` in `store/guide.ts`, the `guideUsage` key)
is three facts and no history: when watching began, how many launches since,
and which features have been used at least once. It is written the first time
a feature is used and never again. **It stays on the machine.** Nothing here
is sent anywhere, and it is not the opt-in telemetry on the roadmap. An
install that predates it starts from zero on its first launch with it, so the
earliest an existing user can see an "unused" tip is `days` after updating.
"Reset all tips and tours" forgets what was shown, not what was used.

### The tips that ship

One per launch, in this order of precedence.

| Tip | The situation | Says |
|---|---|---|
| `agentWaiting` | an agent has been waiting for 2.5s in a task the user is NOT looking at | click the pill to jump to it |
| `reviewChanges` | the task has changed files, no agent in it is working, and the Git view is not open, for 3s | see the diff, commit, or open a pull request |
| `commandPalette` | three days and three launches in, and the palette has never been opened | every action is in this list |
| `statusLine` | `usage n/a`: a custom Claude status line owns the slot | click for the prompt that teaches it to report |
| `agentHooks` | "Usage unknown" and the agent has no hooks | click to install them |
| `addCredentials` | 90% or more of the session or weekly window, and no second account | add a second account |

The last three are about the task footer's agent chip. None fires on a chip
that is simply showing numbers.

### Why the component announces, instead of the layer looking

Looking for `data-guide` in the DOM means watching the DOM while a card waits.
For a guide that is minutes. For a tip about a rare situation it would be for
ever, for every user, waiting for something most never reach. `useTip`
announces the tip to the store, and a tip is not a candidate at all until it
has been announced, so a registry full of tips that are not currently true
costs nothing.

## Adding a guide

```ts
// 1. src/lib/guide/guides.ts
const firstPr: Guide = {
  id: "firstPr",
  steps: [
    { id: "prReview", anchor: "git-tab", side: "left" },
    { id: "prCreate", anchor: "create-pr", side: "left", after: ["prReview"], action: true },
  ],
};
export const GUIDES = [welcome, firstPr];
```

```ts
// 2. Copy, in both locales: guide.guides.firstPr
firstPr: { name: "Your first pull request", steps: { prReview: {...}, prCreate: {...} } },
```

```tsx
// 3. Something that starts it. Either the user asks:
useGuide.getState().startGuide("firstPr");
// or a component offers it, ONCE, the first time its situation arises:
useOfferGuide("firstPr", visible && hasDiff && !hasPr);
```

A step points at a control that is there to be pointed at, so unlike a tip it
names an `anchor` (a `data-guide` on that control) and says `when` in terms of
`GuideCtx`.

- **A guide is not a script.** Steps are in order of precedence, and each has
  its own `when`, so a guide follows what the user does. Someone who wanders
  off for a day picks it up where the app is now.
- **`anchor`** may be an array, in order of preference. A name on many
  elements (one per task, one per project) resolves to the first VISIBLE one.
- **`after`** is a hard dependency on other steps of the same guide.
- **`when`** reads `GuideCtx`. If a rule needs a fact that is not there, add
  it to `GuideCtx` and to the layer's selectors, and keep it cheap: the layer
  subscribes to exactly these (docs/performance.md bear trap 5).
- **`done`** marks the step seen WITHOUT drawing it: the user already did the
  thing. **`action: true`** also ends the step when the control is pressed.
  Every card has "Got it" regardless, and pressing it marks the card seen.
- **`optional: true`** lets the guide end without this step. Use it when the
  control is not there for everybody. A guide that waits on a control the user
  never has would never end, and tips wait for the guide.
- **`over: true`** is for a control inside a menu or a dialog. **`extra`**
  draws a named block under the body (`workMarks` is the real badge legend).

A guide ends when every step is seen, when its required steps are seen and
no optional one has a control on screen to point at, or on "Skip the tour" on
any of its cards. `startGuide` replaces a running guide; `offerGuide` never does.

`src/lib/guide/rules.test.ts` fails if a step or a tip has no copy in either
locale, shares an id with another, names a control no component renders (or
that no component announces), or waits on something that does not exist or is
listed after it.

## What is remembered, and for how long

For ever, per install, in unscoped localStorage (`guideSeen`, `guideShown`).
Every profile window shares it, and the `storage` event carries a change to
windows already open.

- **Dismissed is seen.** "Got it" or the X, step or tip. Every card has
  "Got it", action and passive steps included.
- **Pressing the control is seen, for a tip.** A tip points at something, and
  a press on it (capture `pointerdown` or `click`) marks the tip seen and
  takes the card down, exactly as an `action` step does. The case that forced
  it: the "nearly out" card stayed up over the account panel its own chip had
  just opened.
- **Ignored is seen, for a tip.** A tip nobody touches goes after
  `TIP_VISIBLE_MS` (20s) and is marked seen. Tour steps never time out.
- **Shown is seen, for a tip.** Once the card has been on screen for
  `SHOWN_AFTER_MS` it is written to `guideShown`, whether or not anyone
  presses anything, and when it then leaves the screen for ANY reason it is
  seen in this window too. So doing what a tip says ends it: "An agent is
  waiting, click to jump to it", the user clicks the pill, and the next agent
  to wait does not bring the card back. A guide's step is the exception by
  design: it stays until the thing it asks for is done.
- **One tip per launch** (`TIPS_PER_LAUNCH`), and only with "Show tips" on. A
  guide ignores both: the user started it.
- **An install that was already set up gets none of today's tips.**
  `adoptExisting` runs once per install, the first time this build's tips
  exist on it: if the install has already been through a welcome, every tip
  in the registry is marked seen. A new install has nothing marked. Its user
  already knows the waiting pill and has looked at their usage chip for
  months; the only tips they ever meet are ones a LATER release adds, which
  were not in the registry to be marked. No dates on tips and no version
  compare: "seen" is a list of ids. Nothing is drawn until this has run
  (`checked`).
- **Skipping the tour skips the tour.** "Skip the tour", on the welcome screen
  or on any card, marks that guide's steps and nothing else. The tips stay
  armed.
- **Replay restores that guide's steps only.** A tip that was seen stays seen.
- **Reset is the one way the record is cleared**, and only the user does it:
  Settings, General, "Reset all tips and tours" (`resetAll`). It forgets
  everything seen and shown and ends a running guide, so each tip can show
  once more when its situation arises. It starts nothing itself, and it does
  not undo `adoptExisting`'s "this install has been checked".
- **A guide is offered once.** `offerGuide` records `guide:<id>`, so a
  situation that recurs does not offer it again, and neither does one the
  user skipped.

## What the layer guarantees

- **Nothing to say costs nothing.** `GuideLayer` reads one boolean, and it
  is false unless a guide is running or a control has announced a tip
  (`hasPending`), so on an ordinary launch nothing else is mounted. While it
  IS mounted there are three watchers, each as narrow as its job: `<body>`'s
  direct children for overlays (dialogs and menus are portaled there), a
  ResizeObserver on the one control a card points at, and a coalesced
  subtree watch only while a guide is looking for a step's control that is
  not rendered yet. Nothing observes the whole page while a card is merely
  on screen.
- **It never takes focus.** The card is not focusable and swallows the
  mousedown that would move focus. A card appearing or going away leaves the
  caret in the terminal.
- **It never points at nothing.** A control must pass a hit test at its own
  centre (`elementFromPoint`). That one rule covers a dialog over it, a list
  scrolled away and a pane that is `display: none`. A card whose control is
  not reachable waits; it does not degrade to prose.
- **One window speaks.** Only the focused window draws a card.
- **Off in the e2e binary.** `suppressed` starts true under `VITE_E2E`, so no
  spec finds a card over what it is driving. `guide.e2e.ts` turns it on.

## Traps, each one met while building this

- **Radix dismisses on a press outside.** Menus and dialogs listen for
  `pointerdown` on `document`. A card that points INTO the New task menu sits
  outside it, so "Got it" would close the menu the card is explaining. The
  card stops its own `pointerdown` with a NATIVE listener (a React handler
  runs too late, after the event has reached `document`).
- **`pointer-events: none` on `<body>`.** A modal parks it there, and a
  portaled card inherits it. The card sets `pointer-events: auto` itself, and
  the layer re-checks when that lock lifts, which happens a beat after the
  modal's node is gone.
- **z-index.** The card is at 45: the sidebar's filter row has controls at
  z-40 in the root stacking context, and at 30 an icon drew through the card.
  Dialog and menu content is z-50, so a card never covers one.
- **Settings does not cover the title bar.** A card anchored there passes the
  hit test with Settings open and would draw half under the panel. The layer
  shows nothing while Settings is open.
- **An overlay arriving is handled before paint.** The `<body>` child watch
  resolves inside its own microtask and flushes, so a dialog opening over a
  control never shows a frame of the card on its backdrop. It is the only
  watcher that does: it fires when a portal mounts or unmounts, not on every
  DOM change. An earlier version did this from a subtree observer on the
  whole document, which meant a layout flush and a synchronous React flush
  per keystroke in the editor for as long as any card could show.
- **An unloaded store looks like a new install.** Zero projects at boot would
  fire "Add your first project" for everyone. Every rule is off until `ready`,
  which App sets after the first `loadAll()`.
- **A guide that cannot end.** A step whose control one user never has (a
  hidden right panel) kept the guide running for ever, which silently held
  back every tip. Hence `optional`.
- **A question whose answer was already applied.** The welcome screen asked
  "Keep every agent hooked up", ticked. But the app turns that setting on and
  installs hooks at startup, before the welcome exists, so ticked did nothing
  and unticked flipped a flag without removing a line. The spec only passed
  because it forced the setting off first. The question is gone; do not put
  a control on the welcome whose effect has already happened.
- **A bulk copy edit that matched the wrong key.** Shortening `welcome.intro`
  by "the first `intro:` in the file" rewrote the Run configuration dialog's
  intro instead. Locale keys repeat across blocks; edit by block.

## What it must not become

- A tour that runs on every launch. Seen is permanent.
- A second changelog. The sidebar's "What's new" card and the Changelog
  dialog are the words; a card is a pointer at one control.
- A patch over a control that cannot be found on its own. If a feature needs
  a card to be usable, its placement is the thing to fix.
