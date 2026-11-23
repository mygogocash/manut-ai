// Money and public posts are approved only in the app window, never from a notification (the design canvas, "Money
// never from a notification": a notification's Look opens the request in the app). This app's notifications answer
// nothing at all: an ask's notification says who waits and for what, and a click only opens the chat where the card is.
// These pin that for every kind of ask the connected runtime shows, so an answer from a notification is never added by
// accident: approving from one needs a decision of its own (docs/runtime-adapter.md).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeEvent } from "./protocol";

const { sent } = vi.hoisted(() => ({ sent: [] as unknown[] }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true,
  requestPermission: async () => "granted",
  sendNotification: (options: unknown) => void sent.push(options),
}));

import { noteFor, showNote } from "./notify";

const ask = (command: string, over: Record<string, unknown> = {}) =>
  ({ event: "approval.request", bot: "buddy", request_id: "req-5@1", title: "Refund for order 17", command, choices: ["once", "deny"], ...over }) as unknown as BridgeEvent;
const ctx = { name: () => "Buddy", watching: () => false };

afterEach(() => {
  vi.unstubAllGlobals();
  sent.length = 0;
});

describe("an ask's notification", () => {
  it("says who waits and for what, and holds nothing to answer with, whatever the ask is for", () => {
    for (const ev of [ask("money.refund on order-17"), ask("Post on Facebook: “Open on Saturday”"), ask("Send on LINE: “Thanks!”"), ask("refund_partial", { choices: [], outdated: true })]) {
      const note = noteFor(ev, ctx);
      expect(note && Object.keys(note).sort()).toEqual(["body", "bot", "tag", "title"]);
    }
  });

  it("goes to the system with a title and a body only: no button, no action, nothing that could approve", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, addEventListener: () => {} });
    const note = noteFor(ask("money.refund on order-17"), ctx)!;
    await showNote(note, () => {});
    expect(sent).toEqual([{ title: note.title, body: note.body }]);
  });
});
