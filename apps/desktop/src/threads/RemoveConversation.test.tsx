// The question before a conversation with Buddy is removed, as it is drawn (item 102l-6): it names the conversation and says a removal
// deletes every message in it for good, offers Cancel (which takes the focus: the safe answer) and the destructive button, says why a
// press did not remove it, and has words in all four languages. And Remove on a conversation's row menu: the last entry, for a
// conversation only, never for several rows selected at once.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { LANGS, setLang, t, type Key } from "../i18n";
import { RowMenu } from "../sidebar/RowMenu";
import { removeEntry, RemoveConversationView } from "./RemoveConversation";
import { canRemove } from "./types";
import type { ConversationRef, RemoveState } from "./removeAsk";

afterEach(() => setLang("en"));

const PRICES: ConversationRef = { bot: "buddy", thread: "cht-000000001-abc-00000001", title: "Which prices changed?" };
const draw = (state: Partial<RemoveState> = {}, ref: ConversationRef = PRICES) =>
  renderToString(createElement(RemoveConversationView, { state: { asked: ref, busy: false, error: null, ...state }, onCancel: () => undefined, onConfirm: () => undefined }));

describe("the question", () => {
  it("names the conversation, says a removal deletes every message in it for good, and offers Cancel and the destructive button", () => {
    setLang("en");
    const html = draw();
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/<h2[^>]*data-testid="remove-title"[^>]*>Remove this conversation\?<\/h2>/);
    expect(html).toMatch(/data-testid="remove-name"[^>]*>“Which prices changed\?”<\/p>/);
    expect(html).toMatch(/data-testid="remove-body"[^>]*>This deletes every message in it for good\. It cannot be taken back\.<\/p>/);
    // Cancel is the safe answer, and holds the focus
    expect(html).toMatch(/<button[^>]*data-autofocus[^>]*data-testid="remove-cancel"[^>]*>Cancel<\/button>/);
    expect(html).toMatch(/<button[^>]*class="rm-btn danger"[^>]*data-testid="remove-yes"[^>]*>Remove conversation<\/button>/);
    // no reason before anything was pressed
    expect(html).not.toContain('data-testid="remove-error"');
  });

  it("names a conversation no message has named yet by the name a new thread shows", () => {
    setLang("en");
    expect(draw({}, { ...PRICES, title: "" })).toContain(`“${t("thread.untitled")}”</p>`);
  });

  it("does not let a name be taken for markup", () => {
    const html = draw({}, { ...PRICES, title: '<img src=x onerror=alert(1)>' });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("says why a press did not remove it, as an alert, and keeps both buttons", () => {
    const html = draw({ error: "This conversation is not there any more." });
    expect(html).toMatch(/role="alert"[^>]*data-testid="remove-error"[^>]*>This conversation is not there any more\.<\/p>/);
    expect(html).toContain('data-testid="remove-cancel"');
    expect(html).toContain('data-testid="remove-yes"');
  });

  it("marks both buttons busy while the removal is on its way", () => {
    const html = draw({ busy: true });
    expect(html).toMatch(/aria-disabled="true"[^>]*data-autofocus[^>]*data-testid="remove-cancel"/);
    expect(html).toMatch(/aria-disabled="true" aria-busy="true"[^>]*data-testid="remove-yes"/);
    expect(html).toContain('aria-busy="true" data-testid="remove-conversation"');
  });

  it("draws nothing when no question is open", () => {
    expect(draw({ asked: null })).toBe("");
  });

  it("has its words in every language, with the conversation's name in its own line", () => {
    const keys: Key[] = ["row.removeChat", "thread.chatRemoveTitle", "thread.chatRemoveName", "thread.chatRemoveBody", "thread.chatRemoveYes", "thread.cancel", "rt.chat.removeOwnerOnly", "rt.chat.removeRefused", "rt.chat.removeUnavailable", "older.messages.show", "older.messages.reading", "older.messages.failed"];
    for (const lang of LANGS) {
      setLang(lang);
      for (const key of keys) expect(t(key, { title: "X", owner: "O", shop: "S" }), `${lang} ${key}`).not.toBe(key);
      expect(t("thread.chatRemoveName", { title: "Which prices changed?" }), lang).toContain("Which prices changed?");
    }
  });
});

describe("Remove on a conversation's row menu", () => {
  const menu = (extra: ReturnType<typeof removeEntry> | undefined, keys?: string[]) =>
    renderToString(createElement(RowMenu, { rowKey: "thread:buddy:cht-1", kind: "chat", mark: undefined, name: "Which prices changed?", at: { x: 4, y: 4 }, onDismiss: () => undefined, extra, keys }));

  it("is the last entry, set apart by a line, after Pin, Snooze, Done for now and Archive", () => {
    setLang("en");
    const html = menu(removeEntry(PRICES));
    const at = (id: string) => html.indexOf(`data-testid="${id}"`);
    expect(at("row-pin")).toBeGreaterThan(-1);
    expect(at("row-remove")).toBeGreaterThan(at("row-archive"));
    expect(html).toMatch(/role="separator"[^>]*><\/div><button[^>]*class="row-mi danger"[^>]*data-testid="row-remove"[^>]*>.*Remove conversation…<\/button>/);
  });

  it("is not on the menu of a row that is not a conversation, nor of several rows selected at once", () => {
    expect(menu(undefined)).not.toContain('data-testid="row-remove"');
    expect(menu(removeEntry(PRICES), ["thread:buddy:cht-1", "thread:buddy:cht-2"])).not.toContain('data-testid="row-remove"');
  });

  it("is offered for a conversation of the connected runtime only: not the team's work, and not a thread of a runtime that marks none", () => {
    expect(canRemove({ kind: "chat" })).toBe(true);
    expect(canRemove({ kind: "task" })).toBe(false);
    expect(canRemove({})).toBe(false);
  });
});
