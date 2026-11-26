// What a phone is shown (project.ts): every text masked with the app's one masker, an ask whole, only Allow once and No
// offered, nothing offered for an ask that needs an app update, and a revision that moves only when what is shown moves.
import { describe, expect, it } from "vitest";
import { maskSecrets } from "../lib/secrets";
import { type ChatSource, Projector, askBinding, chatEvents, chatRow } from "./project";
import { sampleChats } from "./testkit/chats";

const TOKEN = "ghp_0123456789abcdefABCDEF0123456789abcd";

function chat(): ChatSource {
  return sampleChats()[0]!;
}

describe("what a phone is shown", () => {
  it("says Working, Needs you or Done", () => {
    const [buddy, kit] = sampleChats();
    expect(chatRow(buddy!).state).toBe("needs_you");
    expect(chatRow(kit!).state).toBe("done");
    expect(chatRow({ ...buddy!, items: buddy!.items.filter((i) => i.kind === "message") }).state).toBe("working");
  });

  it("masks every text with the app's masker", () => {
    expect(maskSecrets(TOKEN)).not.toContain(TOKEN);
    const source: ChatSource = {
      ...chat(),
      title: `deploy ${TOKEN}`,
      step: `Running gh auth with ${TOKEN}`,
      items: [
        { kind: "message", id: "m", role: "assistant", text: `Your token is ${TOKEN}`, ts: 1 },
        { kind: "approval", id: "r", ts: 2, open: true, title: `Use ${TOKEN}`, command: `curl -H "token=${TOKEN}" https://x`, cwd: `/tmp/${TOKEN}`, plan: `Plan with ${TOKEN}`, choices: ["once", "deny"], from: `sub ${TOKEN}` },
        { kind: "clarify", id: "q", ts: 3, open: true, question: `Keep ${TOKEN}?`, choices: [`yes ${TOKEN}`], questions: [{ id: "a", question: `A ${TOKEN}`, choices: [`b ${TOKEN}`] }] },
      ],
    };
    const view = new Projector().view(source);
    const text = JSON.stringify([view, chatRow(source)]);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("••••");
  });

  it("shows an ask whole, with every field its card shows, and nothing cut short", () => {
    const long = `${"line broadcast --to everyone ".repeat(400)}--confirm`;
    const source: ChatSource = { ...chat(), items: [{ kind: "approval", id: "r", ts: 2, open: true, title: "Broadcast", command: long, cwd: "/shop", plan: "1. Draft\n2. Send", choices: ["once", "deny"], from: "Kit" }] };
    expect(new Projector().view(source).asks[0]).toEqual({
      kind: "approval",
      id: "r",
      revision: 1,
      open: true,
      ts: 2,
      title: "Broadcast",
      command: long,
      cwd: "/shop",
      plan: "1. Draft\n2. Send",
      from: "Kit",
      offers: ["once", "deny"],
    });
  });

  it("offers Allow once and No only, and nothing for an ask that needs an app update", () => {
    const base = { kind: "approval" as const, ts: 1, open: true, title: "t", command: "c" };
    const source: ChatSource = {
      ...chat(),
      items: [
        { ...base, id: "all", choices: ["once", "session", "always", "deny"] },
        { ...base, id: "always", choices: ["always", "deny"] },
        { ...base, id: "old", choices: ["once", "deny"], outdated: true },
      ],
    };
    const asks = new Projector().view(source).asks;
    expect(asks.map((a) => (a.kind === "approval" ? [a.offers, a.needsUpdate ?? false] : null))).toEqual([
      [["once", "deny"], false],
      [["deny"], false],
      [[], true],
    ]);
  });

  it("moves an ask's revision only when what it shows changes", () => {
    const projector = new Projector();
    const source = chat();
    const first = projector.ask(source, "req-1");
    expect(first?.revision).toBe(1);
    // Closing it is not a change to what was asked.
    const closed: ChatSource = { ...source, items: source.items.map((i) => (i.kind === "approval" ? { ...i, open: false, resolved: "once" } : i)) };
    expect(projector.ask(closed, "req-1")?.revision).toBe(1);
    const changed: ChatSource = { ...source, items: source.items.map((i) => (i.kind === "approval" ? { ...i, command: "something else" } : i)) };
    expect(projector.ask(changed, "req-1")?.revision).toBe(2);
    expect(projector.ask(changed, "req-1")?.revision).toBe(2);
    // Another chat's ask with the same id has its own revisions.
    expect(projector.ask({ ...changed, key: "kit" }, "req-1")?.revision).toBe(1);
    projector.forget("buddy");
    expect(projector.ask(changed, "req-1")?.revision).toBe(1);
  });

  it("binds a challenge to the chat and the ask so no two pairs run into each other", () => {
    expect(askBinding("a:b", "c")).not.toBe(askBinding("a", "b:c"));
    expect(askBinding("buddy", "req-1")).toBe('["buddy","req-1"]');
  });

  it("keeps the newest 100 messages and every open ask", () => {
    const items: ChatSource["items"] = Array.from({ length: 150 }, (_, i) => ({ kind: "message" as const, id: `m${i}`, role: "user" as const, text: `n${i}`, ts: i }));
    const view = new Projector().view({ ...chat(), items: [...items, ...chat().items.filter((i) => i.kind !== "message")] });
    expect(view.messages).toHaveLength(100);
    expect(view.messages[0]?.text).toBe("n50");
    expect(view.asks.map((a) => a.id)).toEqual(["req-1", "q-1"]);
  });

  it("turns one view into the next with the fewest events", () => {
    const projector = new Projector();
    const before = projector.view(chat());
    expect(chatEvents(before, before)).toEqual([]);
    const after = projector.view({ ...chat(), working: false, step: null, items: [...chat().items, { kind: "message", id: "m9", role: "assistant", text: "Sent", ts: 9 }] });
    expect(chatEvents(before, after).map((e) => e.k)).toEqual(["state", "message"]);
    expect(chatEvents(null, after).filter((e) => e.k === "message")).toHaveLength(3);
  });
});
