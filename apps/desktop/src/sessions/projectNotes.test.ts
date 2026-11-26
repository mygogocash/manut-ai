// Item 93: the shell reads a project's own instruction files as plain text and hands them to the chat's agent
// (src-tauri/src/project_notes.rs), then tells the page which files it read and which it left out and why. The chat says
// that once, quietly, as a system line; a note naming nothing says nothing.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSessions } from "./sessions";
import { notesSaid } from "./projectNotes";
import { createStore, type BridgeLike } from "../state/store";
import type { ChatEvent, SessionHost } from "./host";

const bridge: BridgeLike = { connect: async () => undefined, onAny: () => () => {}, onStatus: () => () => {}, request: (async () => ({})) as BridgeLike["request"] };

function setup() {
  const sinks = new Map<number, (e: ChatEvent) => void>();
  let next = 0;
  const host = {
    kind: "mock",
    reset: async () => {},
    agents: async () => [{ id: "claude", label: "claude", mode: "chat", path: "/bin/claude" }],
    home: async () => "/w",
    pickFolder: async () => null,
    start: async () => 99,
    write: async () => {},
    resize: async () => {},
    close: async () => {},
    chatStart: async (_a: string, _c: string, on: (e: ChatEvent) => void) => {
      const id = ++next;
      sinks.set(id, on);
      return id;
    },
    chatInput: async () => {},
    chatClose: async () => {},
  } as unknown as SessionHost;
  const store = createStore(bridge);
  const ss = createSessions(host, () => store);
  return { ss, store, sinks };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

test("the files read are named, a few by name and the rest counted", () => {
  expect(notesSaid({ read: ["CLAUDE.md"], left: [] })).toBe("Read this project's CLAUDE.md.");
  expect(notesSaid({ read: ["CLAUDE.md", ".claude/rules/testing.md"] })).toBe("Read this project's CLAUDE.md and .claude/rules/testing.md.");
  expect(notesSaid({ read: ["CLAUDE.md", "a.md", "b.md", "c.md", "d.md"] })).toBe("Read this project's CLAUDE.md, a.md, b.md and 2 more.");
});

test("a file left out is named with why: a link, its size, the total, not text, scoped, not passed on", () => {
  expect(notesSaid({ read: [], left: [{ path: "CLAUDE.md", why: "link" }] })).toBe("Left out: CLAUDE.md (a link).");
  expect(notesSaid({ read: ["AGENTS.md"], left: [{ path: "CLAUDE.md", why: "size" }] })).toBe("Read this project's AGENTS.md. Left out: CLAUDE.md (over 64 KB).");
  expect(
    notesSaid({
      left: [
        { path: "a.md", why: "total" },
        { path: "b.md", why: "text" },
        { path: "c.md", why: "scoped" },
        { path: "d.md", why: "unsent" },
      ],
    }),
  ).toBe("Left out: a.md (over 128 KB in all), b.md (not plain text), c.md (only for some files) and 1 more.");
  expect(notesSaid({ left: [{ path: "CLAUDE.md", why: "unsent" }] })).toBe("Left out: CLAUDE.md (could not be passed on).");
});

test("a note that names nothing it can say says nothing", () => {
  expect(notesSaid({})).toBeNull();
  expect(notesSaid({ read: [], left: [] })).toBeNull();
  expect(notesSaid({ read: [7, null, ""], left: [{ path: "x", why: "other" }, { why: "link" }, null, "CLAUDE.md"] })).toBeNull();
});

test("the chat says once what its agent was told, and a restart handing over the same files adds nothing", async () => {
  const t = setup();
  await t.ss.loadAgents();
  const id = t.ss.draft("claude");
  t.ss.setDraft(id, { cwd: "/w/proj" });
  await t.ss.start(id, "hi");
  const key = t.ss.chatKey(id)!;
  const notes = () => (t.store.getState().chats[key]?.items ?? []).flatMap((i) => (i.kind === "system" ? [i.text] : []));
  const before = notes().length;
  t.sinks.get(1)!({ event: "session.note", kind: "instructions", read: ["CLAUDE.md"], left: [{ path: "CLAUDE.local.md", why: "link" }] });
  expect(notes().slice(before)).toEqual(["Read this project's CLAUDE.md. Left out: CLAUDE.local.md (a link)."]);
  // the same note again (the chat restarted on the same files) adds no second line
  t.sinks.get(1)!({ event: "session.note", kind: "instructions", read: ["CLAUDE.md"], left: [{ path: "CLAUDE.local.md", why: "link" }] });
  // nothing to say, nothing said
  t.sinks.get(1)!({ event: "session.note", kind: "instructions", read: [], left: [] });
  t.sinks.get(1)!({ event: "session.note", kind: "instructions" });
  expect(notes().length).toBe(before + 1);
  // the files changed: the new line is said
  t.sinks.get(1)!({ event: "session.note", kind: "instructions", read: ["CLAUDE.md", "AGENTS.md"], left: [] });
  expect(notes().slice(before)).toEqual(["Read this project's CLAUDE.md. Left out: CLAUDE.local.md (a link).", "Read this project's CLAUDE.md and AGENTS.md."]);
});
