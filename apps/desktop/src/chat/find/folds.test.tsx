// Find in a chat (item 150): the folded groups the find holds open. The store the bar and the activity lines share, and the
// activity line itself as it is drawn while a bar is open, while one of its groups is held open, and when neither is.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivityItem } from "../../state/store";
import Activity from "../activity/Activity.slot";
import { finding, forceOpen, foldId, isForced, releaseFold, setFinding } from "./folds";

const BOT = "kami";
const item: ActivityItem = {
  kind: "activity",
  id: "turn-7",
  ts: 1,
  turn: {
    id: "turn-7",
    startedAt: 0,
    endedAt: 3000,
    outcome: "done",
    status: "",
    streaming: "",
    skills: [],
    steps: [
      { id: "s1", name: "terminal", detail: "pnpm test checkout", startedAt: 0, endedAt: 1200, ok: true },
      { id: "s2", name: "read_file", detail: "src/checkout.tsx", startedAt: 1200, endedAt: 1600, ok: true },
    ],
  },
};
const html = () => renderToString(createElement(Activity, { bot: BOT, item, live: false }));
const id = foldId(BOT, item.id);

afterEach(() => {
  setFinding(BOT, false);
  forceOpen([]);
});

describe("the store", () => {
  it("holds exactly the groups it was told to, and lets the rest go", () => {
    forceOpen(["a", "b"]);
    expect([isForced("a"), isForced("b"), isForced("c")]).toEqual([true, true, false]);
    forceOpen(["c"]);
    expect([isForced("a"), isForced("b"), isForced("c")]).toEqual([false, false, true]);
    forceOpen([]);
    expect(isForced("c")).toBe(false);
  });

  it("lets go of one group by hand without touching another", () => {
    forceOpen(["a", "b"]);
    releaseFold("a");
    expect([isForced("a"), isForced("b")]).toEqual([false, true]);
    releaseFold("zzz");
    expect(isForced("b")).toBe(true);
  });

  it("names a group by its chat and its row, so two chats that reuse an id never share one", () => {
    expect(foldId("kami", "t1")).not.toBe(foldId("friren", "t1"));
  });

  it("knows which chats have a bar open", () => {
    setFinding("kami", true);
    expect([finding("kami"), finding("friren")]).toEqual([true, false]);
  });
});

describe("an activity line", () => {
  it("is as it always was while no bar is open: folded, and with no steps in the page", () => {
    const out = html();
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain("activity-details");
    expect(out).not.toContain("pnpm test checkout");
    expect(out).toContain("Worked for 3s · 2 steps");
  });

  it("draws its folded steps hidden while its chat's bar is open, named and marked for the bar to read, and is still shut", () => {
    setFinding(BOT, true);
    const out = html();
    expect(out).toContain('<div class="act-det" data-testid="activity-details" hidden="" data-find-folded="" data-fold="kami\u0001turn-7">');
    expect(out).toContain("pnpm test checkout");
    expect(out).toContain("src/checkout.tsx");
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('class="act"');
  });

  it("draws them for the bar of its own chat only", () => {
    setFinding("friren", true);
    expect(html()).not.toContain("activity-details");
    setFinding("friren", false);
  });

  it("opens, whole, while the find holds it open, and is shut again when the find lets go", () => {
    setFinding(BOT, true);
    forceOpen([id]);
    const open = html();
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('class="act open"');
    expect(open).not.toMatch(/data-testid="activity-details" hidden/);
    expect(open).toContain("pnpm test checkout");
    forceOpen([]);
    const shut = html();
    expect(shut).toContain('aria-expanded="false"');
    expect(shut).toMatch(/data-testid="activity-details" hidden/);
  });

  it("is not opened by a hold on another line's group", () => {
    setFinding(BOT, true);
    forceOpen([foldId(BOT, "turn-8")]);
    expect(html()).toContain('aria-expanded="false"');
  });
});
