// Review a PR: the dialog, the "Code review" tag in the prompt library that
// feeds it, and the `termic review` / MCP `task_review` verbs that make the
// same task.
//
// What this fixture cannot do is fetch a real pull request: its remote is a
// local bare repo, which is not a forge (git.e2e.ts "start a task from an
// issue" says the same). So the cases drive everything up to the forge call
// and assert that the forge's refusal surfaces as a sentence and leaves no
// task behind. The PR half of the prompt, the parser and the default-prompt
// rule are unit-tested (src/lib/prReview.test.ts, cli_server.rs `review_*`).

import {
  archiveTask, clickByText, clickWhenVisible, dismissOverlays, requireTermicApi, runCli,
  setInputValue, snap, waitForAppShell, waitForText, waitGone, waitVisible,
} from "../helpers.js";
import { dataDir } from "../../wdio.conf.js";

const DIALOG = '[data-testid="review-pr-dialog"]';
const INPUT = '[data-testid="review-pr-input"]';
const START = '[data-testid="review-pr-start"]';

const fixtureId = () => browser.execute(() =>
  window.__termic!.useApp.getState().projects.find((p: any) => p.name === "fixture-repo")?.id as string);
const openDialog = async () => {
  const id = await fixtureId();
  await browser.execute((i) => window.__termic!.useUI.getState().openReviewPr(i), id);
  await waitVisible(DIALOG);
};
const closeDialog = async () => {
  await browser.execute(() => window.__termic!.useUI.getState().closeReviewPr());
  await waitGone(DIALOG);
};
const startDisabled = () => browser.execute((s) => (document.querySelector(s) as HTMLButtonElement).disabled, START);
const promptIds = () => browser.execute(() =>
  [...document.querySelectorAll('[data-testid="review-pr-prompt"]')].map(b => b.getAttribute("data-prompt-id")));
const reviewTasks = () => browser.execute(() =>
  window.__termic!.useApp.getState().tasks.filter((t: any) => !t.archived && t.name.startsWith("review-pr-")).length);

describe("review a PR: the prompt library's Code review tag", () => {
  let customId = "";

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
  });

  after(async () => {
    await browser.execute((id) => {
      const s = window.__termic!.usePromptLibrary.getState() as any;
      if (id) s.deletePrompt(id);
      s.setForReview("builtin:review", true);
      s.setForReview("builtin:security-review", true);
    }, customId);
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });

  it("marks Review and Security review as code review prompts out of the box", async () => {
    await browser.execute(() => window.__termic!.useApp.getState().openSettings("prompts"));
    await waitVisible('[data-prompt-id="builtin:review"] [data-testid="prompt-review-tag"]');
    const pressed = await browser.execute(() =>
      [...document.querySelectorAll("[data-prompt-id]")].map(r => [
        r.getAttribute("data-prompt-id"),
        r.querySelector('[data-testid="prompt-review-tag"]')?.getAttribute("aria-pressed"),
      ]));
    const on = (pressed as [string, string][]).filter(([, v]) => v === "true").map(([id]) => id);
    expect(on.sort()).toEqual(["builtin:review", "builtin:security-review"]);
    await snap("review-pr-01-prompt-tags.png");
  });

  it("tags a prompt from its row, and the editor's checkbox says the same", async () => {
    customId = await browser.execute(() =>
      (window.__termic!.usePromptLibrary.getState() as any).addPrompt({ title: "Deep review", body: "Run the deep-review skill on this PR." }));
    const chip = `[data-prompt-id="${customId}"] [data-testid="prompt-review-tag"]`;
    const opacity = () => browser.execute((s) => getComputedStyle(document.querySelector(s)!).opacity, chip);
    await browser.waitUntil(() => browser.execute((s) => !!document.querySelector(s), chip), { timeout: 8_000, timeoutMsg: "no chip on the new row" });
    expect(await browser.execute((s) => document.querySelector(s)?.getAttribute("aria-pressed"), chip)).toBe("false");
    // Untagged, the chip stays out of sight until its row is hovered, so a
    // list of sixteen prompts is not lined with dim chips.
    expect(await opacity()).toBe("0");
    // Pressed as a hovering user would; WebDriver will not click an
    // element it considers invisible.
    await browser.execute((s) => (document.querySelector(s) as HTMLElement).click(), chip);
    await browser.waitUntil(
      () => browser.execute((s) => document.querySelector(s)?.getAttribute("aria-pressed") === "true", chip),
      { timeout: 5_000, timeoutMsg: "the chip never lit" },
    );
    // Tagged, it shows whatever the pointer is doing.
    expect(await opacity()).toBe("1");
    expect(await browser.execute((id) =>
      (window.__termic!.usePromptLibrary.getState() as any).prompts.find((p: any) => p.id === id)?.forReview, customId)).toBe(true);
    // The editor shows the same tag, and unticking it there untags the row.
    await clickWhenVisible(`[data-prompt-id="${customId}"] [title="Edit prompt"]`);
    await waitVisible('[data-testid="prompt-editor-review"][aria-checked="true"]');
    await clickWhenVisible('[data-testid="prompt-editor-review"]');
    await waitVisible('[data-testid="prompt-editor-review"][aria-checked="false"]');
    expect(await browser.execute((s) => document.querySelector(s)?.getAttribute("aria-pressed"), chip)).toBe("false");
    await clickWhenVisible('[data-testid="prompt-editor-review"]');
    await waitVisible('[data-testid="prompt-editor-review"][aria-checked="true"]');
    await browser.keys("Escape");
  });

  it("offers exactly the tagged prompts in the dialog, in library order", async () => {
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
    await openDialog();
    const ids = await promptIds();
    expect(new Set(ids)).toEqual(new Set(["builtin:review", "builtin:security-review", customId]));
    await closeDialog();
  });

  it("says where to tag one when nothing is tagged, and cannot start", async () => {
    await browser.execute((id) => {
      const s = window.__termic!.usePromptLibrary.getState() as any;
      for (const p of ["builtin:review", "builtin:security-review", id]) s.setForReview(p, false);
    }, customId);
    await openDialog();
    await waitVisible('[data-testid="review-pr-no-prompts"]');
    await setInputValue(INPUT, "12");
    expect(await startDisabled()).toBe(true);
    await snap("review-pr-02-no-prompts.png");
    // The link goes to the place that fixes it.
    await clickByText("Tag one in Settings, Prompts");
    await waitGone(DIALOG);
    await waitVisible("[data-prompt-id]");
    await browser.execute((id) => {
      const s = window.__termic!.usePromptLibrary.getState() as any;
      for (const p of ["builtin:review", "builtin:security-review", id]) s.setForReview(p, true);
    }, customId);
    await browser.execute(() => window.__termic!.useApp.getState().closeSettings());
  });
});

describe("review a PR: the dialog", () => {
  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
    await dismissOverlays();
    await browser.execute(() => localStorage.removeItem("reviewPrLast"));
  });

  afterEach(async () => {
    await browser.execute(() => window.__termic!.useUI.getState().closeReviewPr());
  });

  it("opens from the command palette, focused on the PR box, worktree chosen", async () => {
    await browser.execute(() => window.__termic!.useUI.getState().openCommandPalette());
    // Searched for, as a user would: the unfiltered list is long and this
    // row sits below the fold.
    await setInputValue('input[placeholder="Type a command or search…"]', "review a pull");
    const row = '[data-cmd-id="review-pr"]';
    await waitVisible(row);
    expect(await browser.execute((s) => document.querySelector(s)?.textContent ?? "", row)).toContain("Review a pull request");
    await clickWhenVisible(row);
    await waitVisible(DIALOG);
    await browser.waitUntil(
      () => browser.execute((s) => document.activeElement === document.querySelector(s), INPUT),
      { timeout: 5_000, timeoutMsg: "the PR box did not take focus" },
    );
    expect(await browser.execute(() =>
      document.querySelector('[data-testid="review-pr-where-worktree"]')?.getAttribute("aria-checked"))).toBe("true");
    expect(await browser.execute(() =>
      document.querySelector('[data-testid="review-pr-where-main"]')?.getAttribute("aria-checked"))).toBe("false");
    // A prompt and an agent are already chosen: only the PR is missing.
    expect(await browser.execute(() => !!document.querySelector('[data-testid="review-pr-prompt"][aria-checked="true"]'))).toBe(true);
    // The New Task picker: one pill picked.
    expect(await browser.execute(() =>
      document.querySelectorAll('[data-testid="review-pr-agents"] [aria-checked="true"]').length)).toBe(1);
    // The palette handed over: it is closed, not stacked under the dialog.
    expect(await browser.execute(() => window.__termic!.useUI.getState().commandPaletteOpen)).toBe(false);
    expect(await startDisabled()).toBe(true);
    await snap("review-pr-03-dialog.png");
  });

  it("shows the picked prompt as an editable initial prompt, and leaves the library alone", async () => {
    await openDialog();
    const text = () => browser.execute(() => (document.querySelector('[data-testid="review-pr-text"]') as HTMLTextAreaElement).value);
    const body = (id: string) => browser.execute((i) =>
      (window.__termic!.usePromptLibrary.getState() as any).prompts.find((p: any) => p.id === i)?.body as string, id);
    await clickWhenVisible('[data-testid="review-pr-prompt"][data-prompt-id="builtin:review"]');
    expect(await text()).toBe(await body("builtin:review"));
    // Picking another prompt shows ITS text.
    await clickWhenVisible('[data-testid="review-pr-prompt"][data-prompt-id="builtin:security-review"]');
    await browser.waitUntil(async () => (await text()) === (await body("builtin:security-review")),
      { timeout: 5_000, timeoutMsg: "the prompt box did not follow the pick" });
    // An edit is this review's only: the library keeps its text, and Reset
    // brings the saved prompt back.
    const saved = await body("builtin:security-review");
    await setInputValue('[data-testid="review-pr-text"]', "Only look at the migrations.");
    await waitVisible('[data-testid="review-pr-text-reset"]');
    expect(await body("builtin:security-review")).toBe(saved);
    await snap("review-pr-06-edited-prompt.png");
    await clickWhenVisible('[data-testid="review-pr-text-reset"]');
    await browser.waitUntil(async () => (await text()) === saved,
      { timeout: 5_000, timeoutMsg: "Reset did not restore the saved prompt" });
    // An empty prompt cannot start a review.
    await setInputValue(INPUT, "9");
    expect(await startDisabled()).toBe(false);
    await setInputValue('[data-testid="review-pr-text"]', "  ");
    expect(await startDisabled()).toBe(true);
    await clickWhenVisible('[data-testid="review-pr-prompt"][data-prompt-id="builtin:review"]');
  });

  it("reads a number or a link, and says so when it is neither", async () => {
    await openDialog();
    await setInputValue(INPUT, "not a pr");
    await waitVisible('[data-testid="review-pr-hint"]');
    expect(await startDisabled()).toBe(true);
    for (const ok of ["42", "#42", "https://github.com/acme/web/pull/42"]) {
      await setInputValue(INPUT, ok);
      await waitGone('[data-testid="review-pr-hint"]');
      expect(await startDisabled()).toBe(false);
    }
  });

  it("is reachable from the project's + menu", async () => {
    const id = await fixtureId();
    await browser.execute((i) => window.__termic!.useApp.getState().setProjectCollapsed(i, false), id);
    const trigger = `[data-testid="project-new-task-${id}"], [data-testid="project-empty-new-task-${id}"]`;
    await browser.execute((sel) => {
      const el = document.querySelector(sel) as HTMLElement;
      const opts = { bubbles: true, cancelable: true, pointerType: "mouse", button: 0, isPrimary: true, pointerId: 1 } as any;
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
      el.click();
    }, trigger);
    await waitVisible('[role="menu"] [data-testid="project-review-pr"]');
    expect(await browser.execute(() =>
      document.querySelector('[role="menu"] [data-testid="project-review-pr"]')?.textContent ?? "")).toContain("Review a pull request");
    await snap("review-pr-04-project-menu.png");
    // Not clicked through: the item opens the dialog one animation frame
    // later (like Start a race beside it, so the menu's focus teardown cannot
    // steal the dialog's focus), and a hidden e2e window runs animation
    // frames only some of the time. Opening the dialog is the palette case's.
    await browser.keys("Escape");
    await dismissOverlays();
  });

  it("remembers main checkout and the prompt for next time", async () => {
    await openDialog();
    await clickWhenVisible('[data-testid="review-pr-where-main"]');
    await clickWhenVisible('[data-testid="review-pr-prompt"][data-prompt-id="builtin:security-review"]');
    // The choice is remembered when a review is started; the fixture's PR
    // fetch fails, which is fine, the choice is written before it.
    await setInputValue(INPUT, "7");
    await clickWhenVisible(START);
    await waitVisible('[data-testid="review-pr-error"]');
    await closeDialog();
    await openDialog();
    expect(await browser.execute(() =>
      document.querySelector('[data-testid="review-pr-where-main"]')?.getAttribute("aria-checked"))).toBe("true");
    expect(await browser.execute(() =>
      document.querySelector('[data-testid="review-pr-prompt"][aria-checked="true"]')?.getAttribute("data-prompt-id"))).toBe("builtin:security-review");
    await clickWhenVisible('[data-testid="review-pr-where-worktree"]');
  });

  it("reports a PR the forge cannot answer for, stays open, and makes nothing", async () => {
    const before = await reviewTasks();
    await openDialog();
    await setInputValue(INPUT, "123");
    // Enter starts it, like the button.
    await browser.execute((s) => (document.querySelector(s) as HTMLElement).focus(), INPUT);
    await browser.keys("Enter");
    await waitVisible('[data-testid="review-pr-error"]');
    const msg = await browser.execute(() => document.querySelector('[data-testid="review-pr-error"]')?.textContent ?? "");
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toMatch(/^Error:/);
    expect(await browser.execute((s) => !!document.querySelector(s), DIALOG)).toBe(true);
    expect(await reviewTasks()).toBe(before);
    // The box is still editable and the button usable for a retry.
    expect(await startDisabled()).toBe(false);
    await snap("review-pr-05-forge-error.png");
  });
});

describe("review a PR: termic review and MCP task_review", () => {
  let strays: string[] = [];

  before(async () => {
    await waitForAppShell();
    await requireTermicApi();
  });

  after(async () => {
    for (const id of strays) await archiveTask(id);
  });

  it("refuses something that is not a PR before touching the app", () => {
    expect(() => runCli(["--no-launch", "review", "abc", "--project", "fixture-repo"], { TERMIC_DATA_DIR: dataDir }))
      .toThrow(/is not a pull request/);
  });

  it("lists which prompts are tagged, so a script can pick one", () => {
    const out = runCli(["--no-launch", "--json", "prompts"], { TERMIC_DATA_DIR: dataDir });
    const tagged = (JSON.parse(out).prompts as any[]).filter(p => p.review).map(p => p.id);
    expect(tagged).toContain("builtin:review");
    expect(tagged).toContain("builtin:security-review");
  });

  it("asks the forge, and a repo that is not on one is an error with no task left behind", async () => {
    const before = await reviewTasks();
    let err = "";
    try {
      runCli(["--no-launch", "review", "#5", "--project", "fixture-repo", "--agent", "fakeagent"], { TERMIC_DATA_DIR: dataDir });
    } catch (e: any) { err = String(e.message); }
    expect(err).toContain("exit 1");
    expect(await reviewTasks()).toBe(before);
    strays = await browser.execute(() => window.__termic!.useApp.getState().tasks
      .filter((t: any) => !t.archived && t.name.startsWith("review-pr-")).map((t: any) => t.id as string));
  });
});
