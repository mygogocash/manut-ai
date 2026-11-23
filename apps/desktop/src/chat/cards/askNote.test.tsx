// What became of an Approve pressed on a notification is said on the request's card, under its buttons, in the API's own
// words: the app was in the background, so no card was on screen to show it when the answer came back (store.ts
// `approveFromNotification`, notify.ask.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang, t } from "../../i18n";
import type { ApprovalItem } from "../../state/store";
import { askNoteOf, clearAskNote, noteAsk } from "./askNote";
import Cards from "./Cards.slot";

const ask = (): ApprovalItem => ({
  kind: "approval",
  id: "approval-action-1@1",
  ts: 1_795_396_200,
  request_id: "action-1@1",
  title: "Reply to Khun Mali",
  command: "Send on LINE: “Your order ships tomorrow morning.”",
  choices: ["once", "deny"],
});

afterEach(() => {
  clearAskNote("action-1@1");
  clearAskNote("action-2@1");
  vi.unstubAllGlobals();
  setLang("en");
});

describe("the words an answer from a notification left", () => {
  it("are kept by the request's id with its revision, and go when cleared", () => {
    expect(askNoteOf("action-1@1")).toBeNull();
    noteAsk("action-1@1", "Only the owner can approve money");
    expect(askNoteOf("action-1@1")).toBe("Only the owner can approve money");
    expect(askNoteOf("action-1@2")).toBeNull();
    clearAskNote("action-1@1");
    expect(askNoteOf("action-1@1")).toBeNull();
    expect(() => clearAskNote("never-noted")).not.toThrow();
  });

  it("show under the card's buttons, as a refusal pressed on the card does", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    expect(renderToString(<Cards bot="buddy" item={ask()} />)).not.toContain("card-err");
    noteAsk("action-1@1", "The shop has not agreed yet to let Manut AI send for it");
    const html = renderToString(<Cards bot="buddy" item={ask()} />);
    expect(html).toMatch(/class="card-err"[^>]*>Not sent · The shop has not agreed yet to let Manut AI send for it</);
    // the buttons are still there: the request waits for the owner
    expect(html).toContain('data-choice="once"');
    expect(html).toContain('data-choice="deny"');
  });

  it("belong to one request: another card says nothing", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    noteAsk("action-2@1", "No reply from the API. Checking whether your answer arrived");
    expect(renderToString(<Cards bot="buddy" item={ask()} />)).not.toContain("card-err");
  });

  it("are said in the card's own words, in the app's language", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
    setLang("ko");
    noteAsk("action-1@1", "x");
    expect(renderToString(<Cards bot="buddy" item={ask()} />)).toContain(t("card.notSent", { error: "x" }, "ko"));
  });
});
