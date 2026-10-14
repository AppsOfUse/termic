import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({}));

import { historyMatches } from "@/lib/historySearch";
import type { Task } from "@/lib/types";

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1", project_id: "p1", name: "fix-login", branch: "feature/fix-login", base_branch: "main",
  path: "/tasks/web/fix-login", cli: "claude", port: 0, created: "2026-10-01T00:00:00Z", archived: true,
  ...over,
} as Task);

describe("historyMatches", () => {
  const withPr = task({
    pr_number: 123, pr_url: "https://github.com/acme/web/pull/123",
    pr_title: "Fix the login redirect", pr_state: "merged",
  });

  it("finds a task by its PR in every spelling", () => {
    for (const q of ["123", "#123", "!123", "https://github.com/acme/web/pull/123", " #123 "]) {
      expect(historyMatches(withPr, "web", q), q).toBe(true);
    }
  });

  it("matches the PR number exactly, not as a prefix", () => {
    expect(historyMatches(withPr, "web", "#12")).toBe(false);
    expect(historyMatches(withPr, "web", "#1234")).toBe(false);
    expect(historyMatches(task({ pr_number: 120 }), "web", "#12")).toBe(false);
  });

  it("a bare number also finds a task that only names it", () => {
    expect(historyMatches(task({ name: "hotfix-123" }), "web", "123")).toBe(true);
    // ...but "#123" is a PR, and this task has none.
    expect(historyMatches(task({ name: "hotfix-123" }), "web", "#123")).toBe(false);
  });

  it("matches the PR title, its last state, both branches, the project and the agent", () => {
    for (const q of ["login redirect", "MERGED", "feature/fix", "main", "web", "claude", "FIX-LOGIN"]) {
      expect(historyMatches(withPr, "web", q), q).toBe(true);
    }
    expect(historyMatches(withPr, "web", "payments")).toBe(false);
  });

  it("an empty query matches, and a task with no PR fields is searchable", () => {
    expect(historyMatches(task(), "web", "  ")).toBe(true);
    expect(historyMatches(task({ pr_title: null, pr_url: null, pr_state: null }), "web", "merged")).toBe(false);
  });
});
