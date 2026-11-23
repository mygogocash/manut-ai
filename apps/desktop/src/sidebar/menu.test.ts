// The side menu's rules as the design canvas draws them: which row is current for each place in the app, which member
// stands for Home, and which threads the Recent list names.
import { describe, expect, it } from "vitest";
import { currentRow, homeBot, MENU_ROWS, recentThreads } from "./menu";
import type { Ui } from "../state/store";
import type { ThreadRow } from "../threads/types";

/** The row marked current with `view` open, Buddy as the home member. */
const at = (view: Ui["view"], selectedBot: string | null = "buddy", thread: string | null = null) => currentRow({ view, thread }, selectedBot, "buddy");

const row = (thread: string, title: string, started_at: number, last?: number): ThreadRow => ({
  thread,
  title,
  cwd: "",
  started_at,
  running: false,
  needs: false,
  message_count: 0,
  ...(last === undefined ? {} : { last }),
});

describe("the side menu's rows", () => {
  it("are the canvas's rows, top to bottom", () => {
    expect(MENU_ROWS).toEqual(["new", "needs", "team", "code", "artifacts", "customize", "history"]);
  });
});

describe("the current row", () => {
  it("is New on Buddy's main chat, which stands in for Home until Home exists", () => {
    expect(at("chat", "buddy")).toBe("new");
  });

  it("is New before any member is open, where the app starts", () => {
    expect(at("chat", null)).toBe("new");
  });

  it("is Team on another member's main chat, as a member's page marks Team", () => {
    for (const bot of ["nam", "pim", "ton", "kit"]) expect(at("chat", bot), bot).toBe("team");
  });

  it("is none in a thread, Buddy's or another member's", () => {
    expect(at("chat", "buddy", "t1")).toBeNull();
    expect(at("chat", "kit", "t2")).toBeNull();
  });

  it("is the page's own row on Needs you, Team, Artifacts, Customize and History", () => {
    for (const page of ["needs", "team", "artifacts", "customize", "history"] as const) expect(at(page), page).toBe(page);
  });

  it("is Code on the Code page, in a terminal session and on Tasks", () => {
    for (const view of ["code", "session", "tasks"] as const) expect(at(view), view).toBe("code");
  });

  it("is Customize on Automations and Plugins, the entries Customize offers", () => {
    for (const view of ["automations", "plugins"] as const) expect(at(view), view).toBe("customize");
  });

  it("is none in Settings", () => {
    expect(at("settings")).toBeNull();
  });

  it("follows the home member the runtime names, not a fixed id", () => {
    expect(currentRow({ view: "chat", thread: null }, "kami", "kami")).toBe("new");
    expect(currentRow({ view: "chat", thread: null }, "buddy", "kami")).toBe("team");
  });
});

describe("the home member", () => {
  const bot = (name: string, is_default = false) => ({ name, is_default });

  it("is the member the runtime marks as its default", () => {
    expect(homeBot([bot("nam"), bot("buddy", true), bot("pim")], ["nam", "buddy", "pim"])).toBe("buddy");
  });

  it("is the first listed member when no member is the default", () => {
    expect(homeBot([bot("nam"), bot("pim")], ["pim", "nam"])).toBe("pim");
  });

  it("is nobody before the team is known", () => {
    expect(homeBot([], [])).toBeNull();
  });
});

describe("the Recent list", () => {
  it("names the three threads with the newest activity, across members", () => {
    const threads = {
      buddy: [row("b1", "Discount for a bulk order", 100, 900), row("b2", "Translate a supplier's message", 200)],
      nam: [row("n1", "Replies about late parcels", 300, 950)],
      pim: [row("p1", "Weekend sale post", 800)],
    };
    expect(recentThreads(threads, ["buddy", "nam", "pim"])).toEqual([
      { bot: "nam", thread: "n1", title: "Replies about late parcels", ts: 950 },
      { bot: "buddy", thread: "b1", title: "Discount for a bulk order", ts: 900 },
      { bot: "pim", thread: "p1", title: "Weekend sale post", ts: 800 },
    ]);
  });

  it("counts a thread from when it started until something happens in it", () => {
    const threads = { kit: [row("k1", "Thai date format", 500), row("k2", "PromptPay QR", 400, 600)] };
    expect(recentThreads(threads, ["kit"]).map((r) => r.thread)).toEqual(["k2", "k1"]);
  });

  it("leaves out the threads of a member who is not listed", () => {
    const threads = { buddy: [row("b1", "Mine", 100)], gone: [row("g1", "Not on the team", 900)] };
    expect(recentThreads(threads, ["buddy"]).map((r) => r.thread)).toEqual(["b1"]);
  });

  it("keeps a thread with no title yet: the menu gives it the untitled name", () => {
    expect(recentThreads({ buddy: [row("b1", "", 100)] }, ["buddy"])).toEqual([{ bot: "buddy", thread: "b1", title: "", ts: 100 }]);
  });

  it("is empty when no member has a thread", () => {
    expect(recentThreads({}, ["buddy", "nam"])).toEqual([]);
  });

  it("names as many as it is asked for", () => {
    const threads = { buddy: [row("b1", "a", 1), row("b2", "b", 2), row("b3", "c", 3), row("b4", "d", 4)] };
    expect(recentThreads(threads, ["buddy"], 2).map((r) => r.thread)).toEqual(["b4", "b3"]);
  });
});
