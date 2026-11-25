// A row's menu (item 76): what each kind of row offers, and that a terminal is offered no Snooze or Archive.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { LANGS, setLang, t, type Key } from "../i18n";
import { RowMenu, rowChoices } from "./RowMenu";

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

  it("is drawn as a menu named for the row, one item for each choice", () => {
    setLang("en");
    const html = renderToString(createElement(RowMenu, { rowKey: "thread:b:t", kind: "chat", mark: undefined, name: "Weekend sale post", at: { x: 4, y: 4 }, onDismiss: () => undefined }));
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-label="More for Weekend sale post"');
    for (const id of ["pin", "snooze", "settle", "archive"]) expect(html).toContain(`data-testid="row-${id}"`);
  });

  it("has words for every choice in all four languages", () => {
    const keys: Key[] = ["row.pin", "row.unpin", "row.snooze", "row.snooze.hour", "row.snooze.tomorrow", "row.snooze.week", "row.settle", "row.wake", "row.archive", "row.restore"];
    for (const l of LANGS) {
      setLang(l);
      for (const k of keys) expect(t(k), `${l} ${k}`).not.toBe(k);
    }
  });
});
