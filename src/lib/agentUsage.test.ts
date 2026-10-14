import { describe, it, expect, beforeEach } from "vitest";
import {
  USAGE_BODY_PREFIX, parseUsageBody, sameUsage, formatPercent, formatReset, formatUsd,
  usageLevel, drivingWindow, shortWindowWords, USAGE_WARN_PERCENT, USAGE_CRITICAL_PERCENT,
  blocksUsageFeed, statusLineAgentPrompt, type StatusLineOwner,
  formatConsumed, formatPeriod, type PeriodConsumption,
} from "./agentUsage";
import { firstPollDelay } from "@/store/agentUsage";
import { CONTEXT_BODY_PREFIX } from "./agentContext";
import { HOOK_OSC_BODY, HOOK_OSC_READY_BODY, parseNotifyBody, hookOscHandlerData } from "./agentHooks";
import { useAgentUsage, usageKey, foldCost, costTotal, costChipVisible, usageKnown, type UsageEntry } from "@/store/agentUsage";

describe("the usage body", () => {
  // The Rust half of this pair is
  // `the_usage_body_is_not_confusable_with_the_other_signals`. A string cannot
  // be shared across the language boundary, so both sides pin the literal.
  it("is pinned, because agent_hooks.rs writes it and cannot import this", () => {
    expect(USAGE_BODY_PREFIX).toBe("usage ");
  });

  // All three bodies ride OSC 777 with the trusted `termic` title and are told
  // apart by the body ALONE. If one were a prefix of another, a usage report
  // would route into the attention path and badge a tab on every single turn.
  it("cannot be confused with the attention or ready signals", () => {
    for (const other of [HOOK_OSC_BODY, HOOK_OSC_READY_BODY]) {
      expect(USAGE_BODY_PREFIX.startsWith(other)).toBe(false);
      expect(other.startsWith(USAGE_BODY_PREFIX)).toBe(false);
    }
  });
});

describe("parseUsageBody", () => {
  it("reads both windows and their resets", () => {
    expect(parseUsageBody("usage 16 14.000000000000002 1788530400 1788937200")).toEqual({
      session: { usedPercent: 16, resetsAt: 1788530400 },
      weekly: { usedPercent: 14.000000000000002, resetsAt: 1788937200 },
      sessionCostUsd: null,
    });
  });

  it("takes one window without the other", () => {
    // codex on a free plan reports a single long window, so a parser that
    // demanded both would show that user nothing at all.
    expect(parseUsageBody("usage - 49 - 1790491695")).toEqual({
      session: null,
      weekly: { usedPercent: 49, resetsAt: 1790491695 },
      sessionCostUsd: null,
    });
  });

  it("keeps a percentage whose reset is missing", () => {
    expect(parseUsageBody("usage 7 3 - 9")).toEqual({
      session: { usedPercent: 7, resetsAt: null },
      weekly: { usedPercent: 3, resetsAt: 9 },
      sessionCostUsd: null,
    });
  });

  it("is not fooled by an empty field, which Number() would read as 0", () => {
    // The trap this guards: `Number("")` is 0, so a missing percentage would
    // paint a confident "0% used" over a field the agent never sent.
    expect(parseUsageBody("usage  - - -")).toBeNull();
    expect(parseUsageBody("usage - - - -")).toBeNull();
  });

  it("drops a field that is not a bare number", () => {
    // The body reaches a render path from an agent-controlled JSON document.
    // Exponent notation is not a percentage claude or codex ever sends, and
    // accepting it would let `1e9` through to a bar width.
    expect(parseUsageBody("usage 1e9 5 - -")?.session).toBeNull();
    expect(parseUsageBody("usage <script> 5 - -")).toEqual({
      session: null,
      weekly: { usedPercent: 5, resetsAt: null },
      sessionCostUsd: null,
    });
    expect(parseUsageBody("usage -5 - - -")).toBeNull();
  });

  it("clamps, so a provider reporting over 100 cannot overflow the bar", () => {
    expect(parseUsageBody("usage 140 - - -")?.session?.usedPercent).toBe(100);
  });

  it("returns null for every body that is not a usage report", () => {
    expect(parseUsageBody(HOOK_OSC_BODY)).toBeNull();
    expect(parseUsageBody(HOOK_OSC_READY_BODY)).toBeNull();
    expect(parseUsageBody("usagey 1 2 3 4")).toBeNull();
    expect(parseUsageBody("")).toBeNull();
  });

  // End to end through the same parse the OSC handler does, rather than only
  // through the constant: the handler is handed everything after `777;`.
  it("survives the OSC round trip the handler performs", () => {
    const data = hookOscHandlerData("usage 16 14 1788530400 1788937200");
    const body = parseNotifyBody(data);
    expect(body).toBe("usage 16 14 1788530400 1788937200");
    expect(parseUsageBody(body!)?.session?.usedPercent).toBe(16);
  });
});

describe("formatting", () => {
  it("rounds, because the provider sends float noise", () => {
    expect(formatPercent({ usedPercent: 14.000000000000002, resetsAt: null })).toBe("14%");
    expect(formatPercent(null)).toBe("—");
  });

  it("says nothing when there is no reset to report", () => {
    expect(formatReset(null)).toBe("");
    expect(formatReset({ usedPercent: 1, resetsAt: null })).toBe("");
  });

  it("treats the reset as epoch SECONDS, not milliseconds", () => {
    // Getting this backwards is a silent 1970 in the tooltip.
    //
    // Anchored to NOON TODAY rather than `now + 1h`: within the last hour of
    // any day "in an hour" is tomorrow, which renders the weekday form
    // ("resets Mon 00:01") and failed this assertion for anyone running the
    // suite late in the evening. A time-of-day flake in a test about epochs.
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    const secs = Math.floor(noon.getTime() / 1000);
    expect(formatReset({ usedPercent: 1, resetsAt: secs })).toMatch(/^resets \d/);
    // ...and the same number read as MILLISECONDS is the bug this guards.
    expect(new Date(secs).getFullYear()).toBe(1970);
  });
});

describe("the warning thresholds", () => {
  const w = (usedPercent: number) => ({ usedPercent, resetsAt: null });

  it("is neutral below the warn threshold, inclusive of the boundary", () => {
    expect(usageLevel(0)).toBe("normal");
    expect(usageLevel(USAGE_WARN_PERCENT - 0.1)).toBe("normal");
    // The boundary belongs to the WARNING. A footer that waits for 70.1 to
    // colour a number the user reads as "70" is a footer that looks broken.
    expect(usageLevel(USAGE_WARN_PERCENT)).toBe("warn");
    expect(usageLevel(USAGE_CRITICAL_PERCENT - 0.1)).toBe("warn");
    expect(usageLevel(USAGE_CRITICAL_PERCENT)).toBe("critical");
    expect(usageLevel(100)).toBe("critical");
  });

  it("colours by the window closest to its limit, not by the shorter one", () => {
    // The case this exists for: a comfortable session window in front of a
    // nearly-spent week. Reading the session window alone reports good news
    // right up until the turn that fails.
    const d = drivingWindow({ session: w(30), weekly: w(95) , sessionCostUsd: null})!;
    expect(d.label).toBe("wk");
    expect(usageLevel(d.window.usedPercent)).toBe("critical");
  });

  it("prefers the session window when it is the one in trouble", () => {
    const d = drivingWindow({ session: w(95), weekly: w(30) , sessionCostUsd: null})!;
    expect(d.label).toBe("5h");
  });

  it("takes whichever single window exists", () => {
    // codex on a free plan reports only the long one.
    expect(drivingWindow({ session: null, weekly: w(49) , sessionCostUsd: null})!.label).toBe("wk");
    expect(drivingWindow({ session: w(49), weekly: null , sessionCostUsd: null})!.label).toBe("5h");
    expect(drivingWindow({ session: null, weekly: null , sessionCostUsd: null})).toBeNull();
  });

  it("breaks an exact tie towards the session window", () => {
    // Arbitrary but must be STABLE: a tie that flipped between renders would
    // move the colour from one number to the other while nothing changed.
    expect(drivingWindow({ session: w(80), weekly: w(80) , sessionCostUsd: null})!.label).toBe("5h");
  });
});

describe("formatUsd", () => {
  it("shows cents below ten dollars, where the movement is", () => {
    // Watching a session tick from $0.40 to $0.85 is the point. Rounding both
    // to "$0" would make the readout useless exactly when it is interesting.
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.4)).toBe("$0.40");
    expect(formatUsd(3.427)).toBe("$3.43");
    expect(formatUsd(9.994)).toBe("$9.99");
  });

  it("drops the cents from ten dollars up", () => {
    // Cents are noise at that size, and a footer that reflows every few
    // seconds as a digit appears and disappears is worse than a rounded one.
    expect(formatUsd(10)).toBe("$10");
    expect(formatUsd(12.5)).toBe("$13");
    expect(formatUsd(1234.56)).toBe("$1235");
  });

  it("never abbreviates", () => {
    // A spend readout is the one place a rounded-away magnitude is actively
    // unwelcome: "$1.2k" hides whether you spent 1200 or 1249.
    expect(formatUsd(1200)).toBe("$1200");
    expect(formatUsd(1200)).not.toContain("k");
  });

  it("says nothing when there is nothing to say", () => {
    expect(formatUsd(null)).toBe("");
    expect(formatUsd(undefined)).toBe("");
    expect(formatUsd(NaN)).toBe("");
  });
});

describe("cost on the wire", () => {
  it("reads the fifth field", () => {
    const u = parseUsageBody("usage 58 41 100 200 3.25")!;
    expect(u.sessionCostUsd).toBe(3.25);
    expect(u.session?.usedPercent).toBe(58);
  });

  it("treats a four-field body as cost-free, not as broken", () => {
    // A running app can have an OLDER status line installed, which sends
    // four. Appending the field rather than inserting it is what makes that
    // a missing value instead of a misparse.
    const u = parseUsageBody("usage 58 41 100 200")!;
    expect(u.sessionCostUsd).toBeNull();
    expect(u.session?.usedPercent).toBe(58);
    expect(u.weekly?.usedPercent).toBe(41);
  });

  it("accepts cost with no plan windows at all, which is the API-key account", () => {
    // The whole reason cost is read. Before this, the body was rejected
    // outright and that account's footer was empty.
    const u = parseUsageBody("usage - - - - 0.1")!;
    expect(u.sessionCostUsd).toBe(0.1);
    expect(u.session).toBeNull();
    expect(u.weekly).toBeNull();
  });

  it("still rejects a body with nothing readable in it", () => {
    expect(parseUsageBody("usage - - - - -")).toBeNull();
  });

  it("does not clamp spend the way it clamps a percentage", () => {
    // Percentages are clamped to 100 so a provider reporting 101 cannot
    // overflow the bar. Dollars have no ceiling, and clamping them would cap
    // the number at the moment it started to matter.
    expect(parseUsageBody("usage - - - - 250.75")!.sessionCostUsd).toBe(250.75);
  });

  it("drops a cost that is not a bare number", () => {
    expect(parseUsageBody("usage 58 - - - 1e9")!.sessionCostUsd).toBeNull();
    expect(parseUsageBody("usage 58 - - - -3")!.sessionCostUsd).toBeNull();
  });
});

describe("when money is allowed in the chip", () => {
  const entry = (over: Partial<UsageEntry>): UsageEntry => ({
    session: null, weekly: null, sessionCostUsd: 0.1,
    source: "statusline", updatedAt: 0, account: null,
    sawPlan: false, noPlan: false, ...over,
  });

  it("stays hidden until there is proof of no plan", () => {
    // claude sends `cost` on every payload but `rate_limits` only once a turn
    // has reached the API, so a subscription's first reading is
    // indistinguishable from a token-billed account. Showing money there made
    // the footer flip from a dollar figure to a percentage bar mid-turn.
    expect(costChipVisible(entry({}), 0.1)).toBe(false);
  });

  it("shows once a reading has proved there is no plan", () => {
    expect(costChipVisible(entry({ noPlan: true }), 0.1)).toBe(true);
  });

  it("never shows again once a plan has been seen, even on a later gap", () => {
    // `sawPlan` is sticky: a turn that never reached the API reports no
    // windows, and that must not turn a subscription's chip back into money.
    expect(costChipVisible(entry({ sawPlan: true, noPlan: true }), 5)).toBe(false);
  });

  it("shows ZERO on an account known to have no plan, because zero is a reading", () => {
    // Measured on an enterprise usage-based seat: the wire carries
    // `- - - - 0` at session start and `- - - - 0.235401` after the first
    // turn. Requiring a positive figure hid the entire chip in between, so
    // the account that has nothing BUT a dollar figure showed nothing at
    // all, with no sentence saying why. Nothing spent yet is a fact.
    expect(costChipVisible(entry({ noPlan: true }), 0)).toBe(true);
    expect(costChipVisible(undefined, 1)).toBe(false);
  });

  it("stays hidden for a feed that cannot report cost at all", () => {
    // codex answers plan windows and nothing else, so a window-less reading
    // from it would otherwise print "$0.00" for a number it never sent.
    expect(costChipVisible(entry({ noPlan: true, source: "rpc" }), 0)).toBe(false);
    expect(costChipVisible(entry({ noPlan: true, source: "rpc" }), 3)).toBe(false);
  });
});

describe("spend since launch", () => {
  it("sums the live sessions", () => {
    let e = foldCost(undefined, "t1", 0.5);
    e = foldCost(e, "t2", 1.25);
    expect(costTotal(e)).toBeCloseTo(1.75);
  });

  it("replaces a session's total rather than adding to it", () => {
    // claude reports a RUNNING TOTAL, not a delta. Adding readings would
    // multiply the bill by the number of turns.
    let e = foldCost(undefined, "t1", 0.5);
    e = foldCost(e, "t1", 0.9);
    expect(costTotal(e)).toBeCloseTo(0.9);
  });

  it("banks the old total when a session restarts", () => {
    // THE case this exists for. Restarting the agent in a tab starts claude's
    // counter again at zero, and taking the latest reading would erase
    // everything spent before the restart.
    let e = foldCost(undefined, "t1", 2.0);
    e = foldCost(e, "t1", 0.1);   // restarted: counter went backwards
    expect(costTotal(e)).toBeCloseTo(2.1);
    e = foldCost(e, "t1", 0.4);
    expect(costTotal(e)).toBeCloseTo(2.4);
  });

  it("survives several restarts in one tab", () => {
    let e = foldCost(undefined, "t1", 1);
    e = foldCost(e, "t1", 0.5);   // 1 banked
    e = foldCost(e, "t1", 0.2);   // 0.5 banked
    expect(costTotal(e)).toBeCloseTo(1.7);
  });

  it("does not double-count a session resumed somewhere else", () => {
    // THE BUG the session key exists for. claude's cost is a per-session
    // RUNNING TOTAL, so a session resumed in another tab (reopen a task, a
    // second tab on the same conversation, or the account switcher's own
    // restart) reports the same cumulative figure again. Keyed by tab, that
    // arrived as a second session and was added on top: the spend doubled for
    // work nobody did.
    let e = foldCost(undefined, "session-abc", 2.0);
    e = foldCost(e, "session-abc", 2.05);   // same session, new tab, same id
    expect(costTotal(e)).toBeCloseTo(2.05);
  });

  it("still counts a genuinely NEW session on top", () => {
    // The other half: a different conversation is more spend, not a
    // correction. Deduping too eagerly would report only the largest session.
    let e = foldCost(undefined, "session-abc", 2.0);
    e = foldCost(e, "session-def", 0.5);
    expect(costTotal(e)).toBeCloseTo(2.5);
  });

  it("is zero for an account nobody has spent on", () => {
    expect(costTotal(undefined)).toBe(0);
  });
});

describe("the store", () => {
  const reset = () => useAgentUsage.setState({ byAgent: {} });

  it("keys on the agent entry, so two clones never share a number", () => {
    reset();
    const s = useAgentUsage.getState();
    s.report("claude", null, { session: { usedPercent: 10, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    s.report("next-claude", null, { session: { usedPercent: 90, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    const { byAgent } = useAgentUsage.getState();
    expect(byAgent[usageKey("claude", null)].session?.usedPercent).toBe(10);
    expect(byAgent[usageKey("next-claude", null)].session?.usedPercent).toBe(90);
  });

  it("keys on the ACCOUNT too, so two logins of one agent never share a number", () => {
    // The defect this key exists to prevent (GH #278). One agent entry can
    // hold several accounts, so before the account was part of the key two
    // tasks on different logins wrote into one slot and whichever spoke last
    // painted its percentage under the other's name. Nothing failed and
    // nothing looked wrong; the number was simply somebody else's.
    reset();
    const s = useAgentUsage.getState();
    s.report("claude", "Work", { session: { usedPercent: 12, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    s.report("claude", "Personal", { session: { usedPercent: 88, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    const { byAgent } = useAgentUsage.getState();
    expect(byAgent[usageKey("claude", "Work")].session?.usedPercent).toBe(12);
    expect(byAgent[usageKey("claude", "Personal")].session?.usedPercent).toBe(88);
  });

  it("gives the unnamed login a key of its own", () => {
    reset();
    useAgentUsage.getState().report("claude", null, { session: { usedPercent: 30, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    expect(useAgentUsage.getState().byAgent[usageKey("claude", null)].session?.usedPercent).toBe(30);
    // "no account" is not the same as an account with an empty name.
    expect(usageKey("claude", null)).not.toBe(usageKey("claude", ""));
  });

  it("cannot be made to collide, whatever the two halves contain", () => {
    // Both halves are typed by the user in Settings. The first version of
    // this key joined them with a NUL and this test broke it, which is why
    // the key is an encoded tuple: unlikely is not impossible, and the whole
    // point of the key is that one account's spending never lands under
    // another's name.
    const pairs: Array<[string, string | null]> = [
      ["claude", "x"], ["claude\u0000x", null], ["a", "b\u0000c"], ["a\u0000b", "c"],
      ["a", '"]'], ['a"]', null], ["a", null], ["a", ""],
    ];
    expect(new Set(pairs.map(([a, n]) => usageKey(a, n))).size).toBe(pairs.length);
  });

  it("clears one account without touching the agent's others", () => {
    reset();
    const s = useAgentUsage.getState();
    s.report("claude", "Work", { session: { usedPercent: 12, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    s.report("claude", "Personal", { session: { usedPercent: 88, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    s.clear("claude", "Work");
    const { byAgent } = useAgentUsage.getState();
    expect(byAgent[usageKey("claude", "Work")]).toBeUndefined();
    expect(byAgent[usageKey("claude", "Personal")]).toBeDefined();
  });

  it("clears every account when no account is named", () => {
    // What a removed agent needs. An orphaned key would otherwise be
    // inherited by a later agent that happens to reuse the id.
    reset();
    const s = useAgentUsage.getState();
    s.report("claude", null, { session: { usedPercent: 1, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    s.report("claude", "Work", { session: { usedPercent: 2, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    s.report("codex", "Work", { session: { usedPercent: 3, resetsAt: null }, weekly: null , sessionCostUsd: null}, "rpc");
    s.clear("claude");
    const keys = Object.keys(useAgentUsage.getState().byAgent);
    expect(keys).toEqual([usageKey("codex", "Work")]);
  });

  // docs/performance.md bear trap 8. The status line fires on EVERY turn and
  // most turns move a percentage by nothing, so an unchanged write would copy
  // the whole store and re-run every selector on the hottest path there is.
  it("bails on an unchanged reading, object identity included", () => {
    reset();
    const usage = { session: { usedPercent: 10, resetsAt: 5 }, weekly: null, sessionCostUsd: null };
    useAgentUsage.getState().report("claude", null, usage, "statusline");
    const first = useAgentUsage.getState().byAgent;
    // A fresh object with the same VALUES must still be recognised as equal.
    useAgentUsage.getState().report("claude", null, { session: { usedPercent: 10, resetsAt: 5 }, weekly: null , sessionCostUsd: null}, "statusline");
    expect(useAgentUsage.getState().byAgent).toBe(first);
  });

  it("writes when the number actually moves", () => {
    reset();
    const s = useAgentUsage.getState();
    s.report("claude", null, { session: { usedPercent: 10, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    const first = useAgentUsage.getState().byAgent;
    s.report("claude", null, { session: { usedPercent: 11, resetsAt: null }, weekly: null , sessionCostUsd: null}, "statusline");
    expect(useAgentUsage.getState().byAgent).not.toBe(first);
    expect(useAgentUsage.getState().byAgent[usageKey("claude", null)].session?.usedPercent).toBe(11);
  });

  it("writes when the same number arrives from the other transport", () => {
    // Which side reported it is shown in the tooltip, so a switch from the
    // codex RPC to a status line push has to land even at an equal percentage.
    reset();
    const u = { session: { usedPercent: 10, resetsAt: null }, weekly: null, sessionCostUsd: null };
    useAgentUsage.getState().report("codex", null, u, "rpc");
    const first = useAgentUsage.getState().byAgent;
    useAgentUsage.getState().report("codex", null, u, "statusline");
    expect(useAgentUsage.getState().byAgent).not.toBe(first);
  });

  // The bug this exists for: a Claude Max user watched their Session row turn
  // into "not reported", because one payload carried `used_percentage: null`
  // and the whole entry was replaced with it.
  it("keeps a window the newest reading happens to omit", () => {
    reset();
    const s = useAgentUsage.getState();
    s.report("claude", null, {
      session: { usedPercent: 3, resetsAt: 10 },
      weekly: { usedPercent: 18, resetsAt: 20 },
      sessionCostUsd: null,
    }, "statusline");
    // The next turn reports only the weekly one.
    s.report("claude", null, { session: null, weekly: { usedPercent: 19, resetsAt: 20 }, sessionCostUsd: null }, "statusline");
    const e = useAgentUsage.getState().byAgent[usageKey("claude", null)];
    expect(e.session?.usedPercent).toBe(3);
    expect(e.weekly?.usedPercent).toBe(19);
  });

  it("does not invent a window the source never reported", () => {
    // codex on a free plan has no session window at all, and carrying one
    // forward from nothing would be inventing a limit that does not exist.
    reset();
    useAgentUsage.getState().report("codex", null, { session: null, weekly: { usedPercent: 49, resetsAt: 1 } , sessionCostUsd: null}, "rpc");
    expect(useAgentUsage.getState().byAgent[usageKey("codex", null)].session).toBeNull();
  });

  it("never carries a window ACROSS sources", () => {
    // The two transports describe different accounts' shapes. A claude push
    // must not backfill a codex reading, or the chip shows a window that
    // account does not have.
    reset();
    const s = useAgentUsage.getState();
    s.report("x", null, { session: { usedPercent: 5, resetsAt: 1 }, weekly: null , sessionCostUsd: null}, "statusline");
    s.report("x", null, { session: null, weekly: { usedPercent: 7, resetsAt: 2 } , sessionCostUsd: null}, "rpc");
    expect(useAgentUsage.getState().byAgent[usageKey("x", null)].session).toBeNull();
  });

  it("clears without churning the store when there is nothing to clear", () => {
    reset();
    const before = useAgentUsage.getState().byAgent;
    useAgentUsage.getState().clear("nobody");
    expect(useAgentUsage.getState().byAgent).toBe(before);
  });
});

describe("sameUsage", () => {
  it("compares by value, and treats a missing window as different from a present one", () => {
    const a = { session: { usedPercent: 1, resetsAt: 2 }, weekly: null, sessionCostUsd: null };
    expect(sameUsage(a, { session: { usedPercent: 1, resetsAt: 2 }, weekly: null, sessionCostUsd: null })).toBe(true);
    expect(sameUsage(a, { session: { usedPercent: 1, resetsAt: 3 }, weekly: null, sessionCostUsd: null })).toBe(false);
    expect(sameUsage(a, { session: null, weekly: null, sessionCostUsd: null })).toBe(false);
    expect(sameUsage(undefined, undefined)).toBe(true);
    expect(sameUsage(a, undefined)).toBe(false);
  });
});

describe("the blocked-feed explanation", () => {
  const own = (owner: StatusLineOwner["owner"]): StatusLineOwner =>
    ({ owner, path: "/repo/.claude/settings.json", command: "node ./bar.js" });

  it("only calls the feed blocked when something else owns the slot", () => {
    // "termic" and "none" both mean the feed can run, and showing "usage n/a"
    // in either case would be crying wolf on a working setup.
    expect(blocksUsageFeed(own("termic"))).toBe(false);
    expect(blocksUsageFeed(own("none"))).toBe(false);
    expect(blocksUsageFeed(null)).toBe(false);
    expect(blocksUsageFeed(own("project"))).toBe(true);
    expect(blocksUsageFeed(own("project-local"))).toBe(true);
    expect(blocksUsageFeed(own("user"))).toBe(true);
  });

  it("hands the agent everything it needs, and the rules that make it work", () => {
    const p = statusLineAgentPrompt(own("project"));
    // Which file, and what is in it: the user should not have to hunt.
    expect(p).toContain("/repo/.claude/settings.json");
    expect(p).toContain("node ./bar.js");
    // The wire format, exactly as agent_hooks.rs writes it.
    expect(p).toContain("777;notify;termic;usage");
    for (const field of ["five_hour", "seven_day", "used_percentage", "resets_at"]) {
      expect(p).toContain(field);
    }
    // The three rules that decide whether the result works or silently does
    // not: the env guard, stdout being the status line itself, and "-" rather
    // than 0 for a missing value.
    expect(p).toContain("TERMIC_PTY");
    expect(p).toContain("TERMIC_TASK_ID");
    expect(p).toMatch(/Print NOTHING extra on stdout/i);
    expect(p).toMatch(/Never substitute 0/i);
  });

  it("makes the agent ASK where to put the change when the status line is committed", () => {
    // The committed `.claude/settings.json` is the repo's, and the person
    // holding the prompt may not be able to change it. Both ways are offered
    // and the choice is the user's, before a single file is written.
    const p = statusLineAgentPrompt(own("project"));
    expect(p).toMatch(/BEFORE CHANGING ANYTHING, ask the user/);
    expect(p).toMatch(/wait\s+for the answer/);
    // A: in the repo, committed, for everyone.
    expect(p).toMatch(/A\. Change it in the repository/);
    // B: a local override that outranks the committed file and touches
    // nothing tracked.
    expect(p).toContain(".claude/settings.local.json");
    expect(p).toMatch(/Claude reads that file over the\s+committed one/);
    // The wrapper keeps the status line the user already has: it runs the
    // original command and prints its output unchanged.
    expect(p).toMatch(/runs the ORIGINAL command/);
    expect(p).toMatch(/prints that command's output unchanged/);
    // Git-ignored without editing a committed file to make it so.
    expect(p).toContain("git check-ignore");
    expect(p).toContain(".git/info/exclude");
    expect(p).toMatch(/NOT to \.gitignore/);
    expect(p).toMatch(/Do not stage or commit anything/);
  });

  it("does not ask when the status line is already the user's own file", () => {
    // A local override or a user-level status line has one owner and one
    // place to edit. Asking there would be a question with one answer.
    for (const kind of ["project-local", "user"] as const) {
      const p = statusLineAgentPrompt(own(kind));
      expect(p).not.toMatch(/ask the user which of these two/);
      expect(p).not.toContain("settings.local.json in");
      expect(p).toMatch(/edit\s+the script it runs in place/);
      // Still guarded: the script it runs may itself be tracked.
      expect(p).toMatch(/tracked by\s+git, stop and ask/);
    }
  });

  it("teaches the CONTEXT WINDOW, which termic's own status line also reports", () => {
    // The prompt taught usage alone, so a custom status line taught by it
    // filled half the footer: percentages, and a context gauge that stayed
    // empty for good, with nothing on screen saying why.
    const p = statusLineAgentPrompt(own("project"));
    // The wire format, exactly as agent_hooks.rs writes it: the `ctx ` body,
    // raw tokens then the window size.
    expect(p).toContain(`777;notify;termic;${CONTEXT_BODY_PREFIX}<usedTokens> <windowSize>`);
    // The two fields, with their PATH under `context_window`.
    expect(p).toContain("context_window.total_input_tokens");
    expect(p).toContain("context_window.context_window_size");
    // Zero tokens is "before the first call", which the parser drops; a "-"
    // here would not parse at all, unlike in the usage body.
    expect(p).toMatch(/whole numbers greater than\s+zero/);
    // A script taught by the older prompt is extended, not rewritten.
    expect(p).toMatch(/keep that and add what\s+is missing/);
    // Docker: $TERMIC_PTY is a host path the container cannot see.
    expect(p).toContain("/proc/1/fd/1");
  });

  it("teaches the COST field, which is the only signal some accounts have", () => {
    // The prompt taught four fields while the wire format carries five, so
    // anyone who followed it got percentages and never a dollar figure. On an
    // account with no subscription that is the whole reading, so the omission
    // was not "one field missing", it was the feature not working at all.
    const p = statusLineAgentPrompt(own("user"));
    // The PATH, not just the name. Measured against a real claude 2.1.250
    // payload: the field is nested under a top-level `cost` object, and an
    // instruction that says "total_cost_usd" alone leads straight to
    // payload["total_cost_usd"], which is undefined on every account. Our own
    // shell script survives it only because it string-searches the raw JSON.
    expect(p).toContain("cost.total_cost_usd");
    expect(p).toMatch(/NESTED under a top-level "cost"/);
    // Five placeholders in the example line, not four.
    const wire = p.split("\n").find(l => l.includes("usage <5h>"))!;
    expect(wire).toContain("<costUsd>");
    const example = p.split("\n").find(l => /usage \d+ \d+ \d+ \d+ /.test(l));
    expect(example).toBeTruthy();
    expect(example!.trim().split(/\s+/)).toHaveLength(6); // the OSC word + 5 values
  });

  it("does not tell a script to go silent when only the cost is there", () => {
    // The old rule was "send nothing if BOTH percentages are missing", which
    // silences exactly the accounts the cost exists for: an API key, Bedrock,
    // Vertex or an enterprise seat carries no rate_limits at all.
    const p = statusLineAgentPrompt(own("user"));
    expect(p).not.toMatch(/nothing at all if BOTH percentages are missing/i);
    expect(p).toMatch(/only when ALL of the percentages and the cost are\s+missing/i);
  });
});

describe("proving an account has no plan", () => {
  // Measured on claude 2.1.273, Max account, fresh session: the status line
  // sends `cost 0` with no rate_limits before the first message, then
  // rate_limits AND a rising cost together once a turn reaches the API. An
  // enterprise usage-based seat sends `0`, then `0.235401` with no windows.
  const windows = {
    session: { usedPercent: 9, resetsAt: 1 },
    weekly: { usedPercent: 1, resetsAt: 2 },
  };
  const read = (session: string, cost: number | null, plan = false, source: "statusline" | "rpc" = "statusline") =>
    useAgentUsage.getState().report(
      "claude", "Work",
      { session: plan ? windows.session : null, weekly: plan ? windows.weekly : null, sessionCostUsd: cost },
      source, session);
  const entry = () => useAgentUsage.getState().byAgent[usageKey("claude", "Work")];
  const spend = () => costTotal(useAgentUsage.getState().cost[usageKey("claude", "Work")]);

  beforeEach(() => useAgentUsage.setState({ byAgent: {}, cost: {} }));

  it("knows nothing from sessions that have not reached the API, however many", () => {
    // THE BUG. Restoring two tasks after a relaunch sent two window-less
    // readings for one Max account, and a count across sessions called that
    // proof: the second task's footer showed $0.00 and "billed per token".
    read("restored-1", 0);
    read("restored-2", 0);
    read("restored-3", 0);
    expect(entry().noPlan).toBe(false);
    expect(costChipVisible(entry(), spend())).toBe(false);
    expect(usageKnown(entry(), spend())).toBe(false);
  });

  it("a subscription's first turn brings windows, never the proof", () => {
    read("s", 0);
    read("s", 0.119434, true);
    expect(entry().noPlan).toBe(false);
    expect(usageKnown(entry(), spend())).toBe(true);
    expect(costChipVisible(entry(), spend())).toBe(false);
  });

  it("a per-token seat is proved by its first turn's cost", () => {
    read("s", 0);
    expect(usageKnown(entry(), spend())).toBe(false);
    read("s", 0.235401);
    expect(entry().noPlan).toBe(true);
    expect(costChipVisible(entry(), spend())).toBe(true);
    expect(usageKnown(entry(), spend())).toBe(true);
  });

  it("a restored session starting from its old total proves nothing until it rises", () => {
    read("resumed", 1.5);
    read("resumed", 1.5);
    expect(entry().noPlan).toBe(false);
    read("resumed", 1.75);
    expect(entry().noPlan).toBe(true);
  });

  it("the proof lands even when another session already sits at the same total", () => {
    // The unchanged-reading bail compares against the ACCOUNT's last reading,
    // which may be another session's. Dropping this one would lose the proof.
    read("a", 0.5);
    read("b", 0);
    read("b", 0.5);
    expect(entry().noPlan).toBe(true);
  });

  it("a reading with no cost cannot prove anything through a carried total", () => {
    read("a", 2);
    read("b", 0);
    read("b", null);
    expect(entry().noPlan).toBe(false);
  });

  it("stays unproved once a plan was seen, and the chip stays on percentages", () => {
    read("s", 0);
    read("s", 0.1, true);
    read("s2", 0);
    read("s2", 0.3);
    expect(costChipVisible(entry(), spend())).toBe(false);
    expect(usageKnown(entry(), spend())).toBe(true);
  });

  it("codex and devin are untouched: their readings are windows or nothing", () => {
    useAgentUsage.getState().report("codex", null, { ...windows, sessionCostUsd: null }, "rpc");
    const codex = useAgentUsage.getState().byAgent[usageKey("codex", null)];
    expect(codex.noPlan).toBe(false);
    expect(usageKnown(codex, 0)).toBe(true);
    expect(costChipVisible(codex, 0)).toBe(false);
    useAgentUsage.getState().report("devin", null, { session: null, weekly: null, sessionCostUsd: null }, "rpc");
    expect(usageKnown(useAgentUsage.getState().byAgent[usageKey("devin", null)], 0)).toBe(false);
  });

  it("an unchanged reading still writes nothing", () => {
    read("s", 0);
    read("s", 0.2);
    const settled = entry();
    read("s", 0.2);
    read("s", 0.2);
    expect(entry()).toBe(settled);
  });
});

describe("the short window's name", () => {
  it("is 5h for the agents whose quota rolls over in hours", () => {
    for (const base of ["claude", "codex", "anything-else"]) {
      expect(shortWindowWords(base).chip).toBe("5h");
      expect(shortWindowWords(base).label).toBe("Session");
    }
  });

  it("is a day for devin, whose quota is a daily reset", () => {
    // Calling a 24-hour window "5h" in the footer would misname the one number
    // it leads with.
    expect(shortWindowWords("devin").chip).toBe("day");
    expect(shortWindowWords("devin").label).toBe("Daily");
  });
});

describe("firstPollDelay (the pull cadence follows the reading, not the mount)", () => {
  const MS = 120_000;
  const rpc = (updatedAt: number) => ({ updatedAt, source: "rpc" as const });

  it("asks immediately when nothing has been fetched for this credential", () => {
    expect(firstPollDelay(undefined, 1_000_000, MS)).toBe(0);
  });

  it("waits out the remainder when another task already fetched it", () => {
    // 30s old: the number is shared, so this task owes only the other 90s.
    expect(firstPollDelay(rpc(1_000_000 - 30_000), 1_000_000, MS)).toBe(90_000);
  });

  it("asks immediately once the shared reading is older than the interval", () => {
    expect(firstPollDelay(rpc(1_000_000 - MS), 1_000_000, MS)).toBe(0);
    expect(firstPollDelay(rpc(1_000_000 - MS * 3), 1_000_000, MS)).toBe(0);
  });

  it("never delays longer than the interval it is bounded by", () => {
    // A clock that stepped backwards reads as a negative age. Treated as
    // fresh, not as a reason to schedule beyond the staleness ceiling.
    expect(firstPollDelay(rpc(1_000_000 + 60_000), 1_000_000, MS)).toBe(MS);
  });

  it("ignores a pushed reading, which is not evidence a pull would agree", () => {
    // claude's status line can write this key. Suppressing another agent's
    // fetch on it would let one transport silence the other.
    const pushed = { updatedAt: 1_000_000 - 1_000, source: "statusline" as const };
    expect(firstPollDelay(pushed, 1_000_000, MS)).toBe(0);
  });

  it("is the old behaviour for the case that matters: a cold first paint", () => {
    // The regression this must not cause is a chip that stays empty on open.
    expect(firstPollDelay(undefined, Date.now(), MS)).toBe(0);
  });
});

describe("an uncapped plan's consumption (devin Enterprise, ACU-billed)", () => {
  const acu = (amount: number, over: Partial<PeriodConsumption> = {}): PeriodConsumption =>
    ({ amount, unit: "ACU", periodStart: 1894262400, periodEnd: 1896940800, ...over });
  const report = (consumed: PeriodConsumption | null) =>
    useAgentUsage.getState().report("devin", null, { session: null, weekly: null, sessionCostUsd: null, consumed }, "rpc");
  const entry = () => useAgentUsage.getState().byAgent[usageKey("devin", null)];

  beforeEach(() => useAgentUsage.setState({ byAgent: {}, cost: {} }));

  it("is a known reading, so the footer does not say Usage unknown", () => {
    report(null);
    expect(usageKnown(entry(), 0)).toBe(false);
    report(acu(70.56));
    expect(usageKnown(entry(), 0)).toBe(true);
  });

  it("reads as a count with its unit, a tenth early and whole numbers later", () => {
    expect(formatConsumed(acu(70.56))).toBe("70.6 ACU");
    expect(formatConsumed(acu(0))).toBe("0.0 ACU");
    expect(formatConsumed(acu(1234.4))).toBe("1234 ACU");
    expect(formatConsumed(null)).toBe("");
  });

  it("names its billing period only when both bounds are known", () => {
    expect(formatPeriod(acu(1))).toMatch(/ to /);
    expect(formatPeriod(acu(1, { periodEnd: null }))).toBe("");
  });

  it("an unchanged reading is not written again, a moved one is", () => {
    report(acu(70.56));
    const first = entry();
    report(acu(70.56));
    expect(entry()).toBe(first);
    report(acu(71));
    expect(entry()).not.toBe(first);
    expect(sameUsage(
      { session: null, weekly: null, sessionCostUsd: null, consumed: acu(1) },
      { session: null, weekly: null, sessionCostUsd: null, consumed: acu(1, { periodEnd: 1 }) },
    )).toBe(false);
  });
});
