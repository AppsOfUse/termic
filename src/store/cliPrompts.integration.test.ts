// @vitest-environment happy-dom
//
// `termic prompts` / `-P` (Phase 4) driven through the REAL
// `listPromptsHandler` against the REAL prompt library store. The Rust
// server resolves selectors against exactly this handler's output, so
// what these tests pin is the RPC contract's data source: overrides
// applied, deleted builtins absent, disabled prompts present with the
// flag, bodies riding along. A test that fabricated the list would pass
// against a copy of any drift.
//
// localStorage rule (see prefs.test.ts): never touch the global one;
// the store hydrates from a Map-backed fake per test via
// vi.resetModules() + dynamic import, because prompts.ts reads
// localStorage once at module load.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  };
}

async function fresh() {
  const [{ listPromptsHandler }, { usePromptLibrary }] = await Promise.all([
    import("@/lib/cliRpc"),
    import("@/store/prompts"),
  ]);
  return { listPromptsHandler, usePromptLibrary };
}

describe("cli list_prompts (Phase 4)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("returns the builtin library with ids, flags and bodies", async () => {
    const { listPromptsHandler } = await fresh();
    const { prompts } = listPromptsHandler();
    const review = prompts.find(p => p.id === "builtin:review");
    expect(review).toBeDefined();
    expect(review!.builtin).toBe(true);
    expect(review!.enabled).toBe(true);
    expect(review!.modified).toBe(false);
    // Bodies ride along: the server substitutes them for -P without a
    // second round-trip.
    expect(review!.body.length).toBeGreaterThan(0);
    // Every entry carries the full shape the Rust resolver deserializes.
    for (const p of prompts) {
      expect(typeof p.id).toBe("string");
      expect(typeof p.title).toBe("string");
      expect(typeof p.body).toBe("string");
      expect(typeof p.builtin).toBe("boolean");
      expect(typeof p.enabled).toBe("boolean");
      expect(typeof p.modified).toBe("boolean");
    }
    // The list path asks for bodies:false and gets empty strings in a
    // stable shape (the field never disappears; Rust requires it).
    const slim = listPromptsHandler({ bodies: false }).prompts;
    expect(slim.length).toBe(prompts.length);
    expect(slim.every(p => p.body === "")).toBe(true);
    expect(slim.find(p => p.id === "builtin:review")!.title).toBe(review!.title);
  });

  it("reflects live overrides, and unedited builtins keep the shipped text", async () => {
    const { listPromptsHandler, usePromptLibrary } = await fresh();
    const shippedCommit = listPromptsHandler().prompts.find(p => p.id === "builtin:commit")!.body;
    usePromptLibrary.getState().updatePrompt("builtin:review", {
      title: "My Review", body: "Custom body.",
    });
    const { prompts } = listPromptsHandler();
    const review = prompts.find(p => p.id === "builtin:review")!;
    // The override is what -P delivers, under the SAME stable id.
    expect(review.title).toBe("My Review");
    expect(review.body).toBe("Custom body.");
    expect(review.modified).toBe(true);
    // A sibling builtin still tracks the shipped default.
    expect(prompts.find(p => p.id === "builtin:commit")!.body).toBe(shippedCommit);
  });

  it("omits deleted builtins and flags disabled ones without hiding them", async () => {
    const { listPromptsHandler, usePromptLibrary } = await fresh();
    usePromptLibrary.getState().deletePrompt("builtin:commit");
    usePromptLibrary.getState().toggleEnabled("builtin:review");
    const { prompts } = listPromptsHandler();
    // Deleted builtins do not exist (selectors must not resolve them).
    expect(prompts.some(p => p.id === "builtin:commit")).toBe(false);
    // Disabled = hidden from the dropdown, not dead: still listed, still
    // fireable by explicit selector server-side.
    const review = prompts.find(p => p.id === "builtin:review")!;
    expect(review.enabled).toBe(false);
  });

  it("lists custom prompts under their UUID ids", async () => {
    const { listPromptsHandler, usePromptLibrary } = await fresh();
    const id = usePromptLibrary.getState().addPrompt({ title: "Ship it", body: "Ship the diff." });
    const custom = listPromptsHandler().prompts.find(p => p.id === id)!;
    expect(custom.builtin).toBe(false);
    expect(custom.title).toBe("Ship it");
    expect(custom.body).toBe("Ship the diff.");
  });
});

describe("the Code review tag (Review a PR, `termic review`)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("tags Review and Security review by default, and nothing else", async () => {
    const { listPromptsHandler } = await fresh();
    const tagged = listPromptsHandler().prompts.filter(p => p.review).map(p => p.id);
    expect(tagged).toEqual(["builtin:review", "builtin:security-review"]);
  });

  it("tags a custom prompt, untags a built-in, and stores only the difference", async () => {
    const { listPromptsHandler, usePromptLibrary } = await fresh();
    const s = usePromptLibrary.getState();
    const id = s.addPrompt({ title: "Deep review", body: "Run the deep-review skill." });
    s.setForReview(id, true);
    s.setForReview("builtin:security-review", false);
    const tagged = listPromptsHandler().prompts.filter(p => p.review).map(p => p.id);
    expect([...tagged].sort()).toEqual(["builtin:review", id].sort());
    // Untagging back to the default leaves nothing behind for that id.
    usePromptLibrary.getState().setForReview("builtin:security-review", true);
    const stored = JSON.parse(localStorage.getItem("promptLibrary") ?? "{}");
    expect(stored.labels).toEqual({ [id]: ["code-review"] });
  });

  it("survives a reload, and a deleted prompt takes its tag with it", async () => {
    let { usePromptLibrary } = await fresh();
    const id = usePromptLibrary.getState().addPrompt({ title: "Deep review", body: "x" });
    usePromptLibrary.getState().setForReview(id, true);
    vi.resetModules();
    ({ usePromptLibrary } = await fresh());
    expect(usePromptLibrary.getState().prompts.find(p => p.id === id)?.forReview).toBe(true);
    usePromptLibrary.getState().deletePrompt(id);
    expect(JSON.parse(localStorage.getItem("promptLibrary") ?? "{}").labels).toEqual({});
  });

  it("a clone of a tagged prompt stays tagged", async () => {
    const { usePromptLibrary } = await fresh();
    const copy = usePromptLibrary.getState().clonePrompt("builtin:review")!;
    expect(usePromptLibrary.getState().prompts.find(p => p.id === copy)?.forReview).toBe(true);
  });

  it("offers only tagged, enabled prompts with a body", async () => {
    const { usePromptLibrary } = await fresh();
    const { reviewPrompts } = await import("@/store/prompts");
    const s = usePromptLibrary.getState();
    const empty = s.addPrompt({ title: "Empty", body: "  " });
    s.setForReview(empty, true);
    s.toggleEnabled("builtin:security-review");
    expect(reviewPrompts(usePromptLibrary.getState().prompts).map(p => p.id)).toEqual(["builtin:review"]);
  });
});

describe("prompt labels", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const labelsOf = async (id: string) => {
    const { usePromptLibrary } = await import("@/store/prompts");
    return usePromptLibrary.getState().prompts.find(p => p.id === id)!.labels;
  };

  it("adds, de-duplicates and removes labels of the user's own", async () => {
    const { usePromptLibrary } = await fresh();
    const s = usePromptLibrary.getState();
    const id = s.addPrompt({ title: "Perf pass", body: "x" });
    s.addLabel(id, "  Backend  ");
    s.addLabel(id, "backend");
    s.addLabel(id, "perf   checks");
    s.addLabel(id, "   ");
    expect(await labelsOf(id)).toEqual(["Backend", "perf checks"]);
    usePromptLibrary.getState().removeLabel(id, "BACKEND");
    expect(await labelsOf(id)).toEqual(["perf checks"]);
  });

  it("any spelling of code review is the built-in label, so it reaches Review a PR", async () => {
    const { usePromptLibrary } = await fresh();
    const { reviewPrompts } = await import("@/store/prompts");
    const s = usePromptLibrary.getState();
    const id = s.addPrompt({ title: "Deep review", body: "Run the deep-review skill." });
    s.addLabel(id, "Code Review");
    expect(await labelsOf(id)).toEqual(["code-review"]);
    expect(reviewPrompts(usePromptLibrary.getState().prompts).map(p => p.id)).toContain(id);
    for (const spelling of ["code_review", "CODE-REVIEW"]) {
      const other = usePromptLibrary.getState().addPrompt({ title: spelling, body: "y" });
      usePromptLibrary.getState().addLabel(other, spelling);
      expect(await labelsOf(other)).toEqual(["code-review"]);
    }
  });

  it("lists every label in use, code review first", async () => {
    const { usePromptLibrary } = await fresh();
    const { allLabels } = await import("@/store/prompts");
    const s = usePromptLibrary.getState();
    const a = s.addPrompt({ title: "a", body: "x" });
    s.addLabel(a, "zeta");
    s.addLabel(a, "Alpha");
    expect(allLabels(usePromptLibrary.getState().prompts)).toEqual(["code-review", "Alpha", "zeta"]);
  });

  it("a built-in put back to its default labels stores nothing, so a better default still reaches it", async () => {
    const { usePromptLibrary } = await fresh();
    const s = usePromptLibrary.getState();
    s.addLabel("builtin:review", "team");
    expect(JSON.parse(localStorage.getItem("promptLibrary") ?? "{}").labels["builtin:review"]).toEqual(["code-review", "team"]);
    usePromptLibrary.getState().removeLabel("builtin:review", "team");
    expect(JSON.parse(localStorage.getItem("promptLibrary") ?? "{}").labels).toEqual({});
  });

  it("reads 1.16.0's review flags as the code review label", async () => {
    localStorage.setItem("promptLibrary", JSON.stringify({
      customs: [{ id: "c1", title: "Deep review", body: "x" }],
      review: { c1: true, "builtin:security-review": false },
    }));
    await fresh();
    expect(await labelsOf("c1")).toEqual(["code-review"]);
    expect(await labelsOf("builtin:security-review")).toEqual([]);
    expect(await labelsOf("builtin:review")).toEqual(["code-review"]);
  });

  it("reports labels to the CLI, and a clone keeps them", async () => {
    const { listPromptsHandler, usePromptLibrary } = await fresh();
    const s = usePromptLibrary.getState();
    const id = s.addPrompt({ title: "Infra", body: "x" });
    s.addLabel(id, "infra");
    s.addLabel(id, "code review");
    const copy = usePromptLibrary.getState().clonePrompt(id)!;
    const rows = listPromptsHandler().prompts;
    expect(rows.find(p => p.id === id)?.labels).toEqual(["infra", "code-review"]);
    expect(rows.find(p => p.id === copy)?.labels).toEqual(["infra", "code-review"]);
    expect(rows.find(p => p.id === copy)?.review).toBe(true);
  });
});
