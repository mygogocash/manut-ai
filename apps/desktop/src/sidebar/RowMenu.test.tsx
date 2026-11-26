// A row's menu (item 76): what each kind of row offers, and that a terminal is offered no Snooze or Archive.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { LANGS, setLang, t, type Key } from "../i18n";
import { pickStart, RowMenu, rowChoices, settledWhy, snoozeChoices } from "./RowMenu";

afterEach(() => setLang("en"));

describe("what a row's menu offers", () => {
  it("gives a chat and a lane Pin, Snooze, Done for now and Archive", () => {
    for (const kind of ["chat", "lane"] as const) expect(rowChoices(kind, undefined), kind).toEqual(["pin", "snooze", "settle", "archive"]);
  });

  it("gives a terminal only Pin and Done for now", () => {
    expect(rowChoices("terminal", undefined)).toEqual(["pin", "settle"]);
  });

  it("offers the opposite of what is done: Unpin, Bring back for a snoozed or settled row, and only a way out of the archive", () => {
    expect(rowChoices("chat", { pinned: 1 })).toEqual(["unpin", "snooze", "settle", "archive"]);
    expect(rowChoices("chat", { snoozed: 5 })).toEqual(["pin", "snooze", "wake", "archive"]);
    expect(rowChoices("lane", { settled: true })).toEqual(["pin", "snooze", "wake", "archive"]);
    expect(rowChoices("chat", { archived: 5 })).toEqual(["restore"]);
  });

  it("offers Until it finishes only for a row whose turn runs, and a picked time always (item 94)", () => {
    expect(snoozeChoices(true)).toEqual(["done", "pick"]);
    expect(snoozeChoices(false)).toEqual(["pick"]);
    // a row snoozed until it finishes offers Bring back, as any snoozed row does
    expect(rowChoices("chat", { untilDone: 5 })).toEqual(["pin", "snooze", "wake", "archive"]);
  });

  it("says on the row's second line why it settled by itself, and nothing for a row the person settled (item 94)", () => {
    setLang("en");
    expect(settledWhy({ settled: true, why: "quiet", days: 3 })).toBe("Done after 3 quiet days");
    expect(settledWhy({ settled: true, why: "quiet", days: 1 })).toBe("Done after a quiet day");
    expect(settledWhy({ settled: true, why: "merged" })).toBe("Done: its pull request merged");
    expect(settledWhy({ settled: true })).toBeNull();
    expect(settledWhy({ back: 4 })).toBeNull();
  });

  it("starts a picked time at the next whole hour", () => {
    expect(pickStart(new Date(2026, 10, 26, 14, 30).getTime())).toEqual({ date: "2026-11-26", time: "15:00" });
    expect(pickStart(new Date(2026, 10, 30, 23, 10).getTime())).toEqual({ date: "2026-12-01", time: "00:00" });
  });

  it("acts on several selected rows with Pin, Snooze, Done for now and Archive only (item 94)", () => {
    setLang("en");
    const html = renderToString(createElement(RowMenu, { rowKey: "thread:b:t", kind: "chat", mark: { pinned: 1 }, name: "3 chats", at: { x: 4, y: 4 }, onDismiss: () => undefined, keys: ["thread:b:t", "thread:b:u", "thread:b:v"] }));
    expect(html).toContain('aria-label="More for 3 chats"');
    for (const id of ["pin", "snooze", "settle", "archive"]) expect(html).toContain(`data-testid="row-${id}"`);
    expect(html).not.toContain('data-testid="row-unpin"');
  });

  it("is drawn as a menu named for the row, one item for each choice", () => {
    setLang("en");
    const html = renderToString(createElement(RowMenu, { rowKey: "thread:b:t", kind: "chat", mark: undefined, name: "Weekend sale post", at: { x: 4, y: 4 }, onDismiss: () => undefined }));
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-label="More for Weekend sale post"');
    for (const id of ["pin", "snooze", "settle", "archive"]) expect(html).toContain(`data-testid="row-${id}"`);
  });

  it("has words for every choice in all four languages", () => {
    const keys: Key[] = ["row.pin", "row.unpin", "row.snooze", "row.snooze.hour", "row.snooze.tomorrow", "row.snooze.week", "row.settle", "row.wake", "row.archive", "row.restore", "row.snooze.done", "row.snooze.doneTip", "row.snooze.pick", "row.pick.date", "row.pick.time", "row.pick.late", "row.snoozedDone", "row.done.pin", "row.done.snooze", "row.done.settle", "row.done.archive", "row.why.quiet", "row.why.quiet1", "row.why.merged", "row.count", "row.selected", "inbox.group", "inbox.working", "inbox.workingHint", "inbox.quiet", "inbox.quietHint", "inbox.merged", "inbox.mergedHint", "inbox.day1", "inbox.days", "menu.working"];
    for (const l of LANGS) {
      setLang(l);
      for (const k of keys) expect(t(k), `${l} ${k}`).not.toBe(k);
    }
  });
});
