// The side menu's rules as the design canvas draws them: which row is current for each place in the app, the page each
// row opens, which member Home's ask box talks to, and which threads the Recent list names.
import { describe, expect, it } from "vitest";
import { currentRow, homeBot, MENU_ROWS, recentParts, recentThreads, rowPage } from "./menu";
import { threadRowKey } from "./rows";
import type { Ui } from "../state/store";
import type { ThreadRow } from "../threads/types";

/** The row marked current with `view` open. */
const at = (view: Ui["view"], selectedBot: string | null = "buddy", thread: string | null = null) => currentRow({ view, thread }, selectedBot);

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

describe("the page a row opens", () => {
  it("is Home for New, and each other row's own page", () => {
    expect(rowPage("new")).toBe("home");
    for (const row of ["needs", "team", "code", "artifacts", "customize", "history"] as const) expect(rowPage(row), row).toBe(row);
  });
});

describe("the current row", () => {
  it("is New on Home, the page the New row and the brand mark open", () => {
    expect(at("home")).toBe("new");
  });

  it("is New before any member is open, as the app starts on Home", () => {
    expect(at("chat", null)).toBe("new");
  });

  it("is Team on any member's main chat, Buddy's too: a member's page marks Team", () => {
    for (const bot of ["buddy", "nam", "pim", "ton", "kit"]) expect(at("chat", bot), bot).toBe("team");
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
});

describe("the home member, whom Home's Chat and Team modes talk to", () => {
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

describe("the places Mission Control adds", () => {
  it("marks History for the activity log, which is History's own place, and no row for a job's page", () => {
    expect(at("activity")).toBe("history");
    expect(at("job")).toBeNull();
  });
});

describe("Recent with pinned, settled, snoozed and archived chats", () => {
  const NOW = 10_000;
  const threads = {
    buddy: [row("b1", "one", 100, 900), row("b2", "two", 100, 800), row("b3", "three", 100, 700), row("b4", "four", 100, 600), row("b5", "five", 100, 500), row("b6", "six", 100, 400)],
  };
  const calm = () => false;
  const key = (t: string) => threadRowKey("buddy", t);
  const ids = (xs: { thread: string }[]) => xs.map((x) => x.thread);

  it("is the three newest and nothing else when no chat is marked", () => {
    const p = recentParts(threads, ["buddy"], {}, calm, NOW);
    expect(ids(p.recent)).toEqual(["b1", "b2", "b3"]);
    expect(p.pinned).toEqual([]);
    expect(p.settled).toEqual([]);
  });

  it("puts the pinned on top in the order pinned, whatever their age, and they do not count against the three", () => {
    const p = recentParts(threads, ["buddy"], { [key("b6")]: { pinned: 2 }, [key("b4")]: { pinned: 1 } }, calm, NOW);
    expect(ids(p.pinned)).toEqual(["b4", "b6"]);
    expect(ids(p.recent)).toEqual(["b1", "b2", "b3"]);
  });

  it("leaves a snoozed chat out until its time, and an archived one out for good, and the next newest take their places", () => {
    const marks = { [key("b1")]: { snoozed: NOW + 1 }, [key("b2")]: { archived: 5 } };
    expect(ids(recentParts(threads, ["buddy"], marks, calm, NOW).recent)).toEqual(["b3", "b4", "b5"]);
    // its time has come
    expect(ids(recentParts(threads, ["buddy"], marks, calm, NOW + 1).recent)).toEqual(["b1", "b3", "b4"]);
  });

  it("lists a settled chat below the others, and brings a snoozed or settled chat back the moment it asks something", () => {
    const marks = { [key("b1")]: { settled: true as const }, [key("b2")]: { snoozed: NOW + 5_000 } };
    const quiet = recentParts(threads, ["buddy"], marks, calm, NOW);
    expect(ids(quiet.settled)).toEqual(["b1"]);
    expect(ids(quiet.recent)).toEqual(["b3", "b4", "b5"]);
    const asked = recentParts(threads, ["buddy"], marks, (_bot, r) => r.thread === "b1" || r.thread === "b2", NOW);
    expect(ids(asked.recent)).toEqual(["b1", "b2", "b3"]);
    expect(asked.settled).toEqual([]);
  });
});

describe("the Working group (item 94)", () => {
  const NOW = 10_000;
  const threads = {
    buddy: [row("b1", "one", 100, 900), row("b2", "two", 100, 800), row("b3", "three", 100, 700), row("b4", "four", 100, 600), row("b5", "five", 100, 500)],
  };
  const key = (t: string) => threadRowKey("buddy", t);
  const ids = (xs: { thread: string }[]) => xs.map((x) => x.thread);
  const busy = (...ts: string[]) => (_bot: string, r: { thread: string }) => ts.includes(r.thread);

  it("is empty while it is off, and a working chat stays in Recent", () => {
    const p = recentParts(threads, ["buddy"], {}, () => false, NOW, 3, { working: busy("b1", "b2") });
    expect(p.working).toEqual([]);
    expect(ids(p.recent)).toEqual(["b1", "b2", "b3"]);
  });

  it("holds the working chats when on, newest first, and the next newest take their places in Recent", () => {
    const p = recentParts(threads, ["buddy"], {}, () => false, NOW, 3, { working: busy("b1", "b3"), group: true });
    expect(ids(p.working)).toEqual(["b1", "b3"]);
    expect(ids(p.recent)).toEqual(["b2", "b4", "b5"]);
  });

  it("never holds a chat that asks something: it stays in Recent", () => {
    const p = recentParts(threads, ["buddy"], {}, busy("b1"), NOW, 3, { working: busy("b1", "b2"), group: true });
    expect(ids(p.working)).toEqual(["b2"]);
    expect(ids(p.recent)).toEqual(["b1", "b3", "b4"]);
  });

  it("leaves a pinned, settled or snoozed chat where its mark puts it", () => {
    const marks = { [key("b1")]: { pinned: 1 }, [key("b2")]: { settled: true as const }, [key("b3")]: { untilDone: 5 } };
    const p = recentParts(threads, ["buddy"], marks, () => false, NOW, 3, { working: busy("b1", "b2", "b3"), group: true });
    expect(ids(p.pinned)).toEqual(["b1"]);
    expect(ids(p.settled)).toEqual(["b2"]);
    expect(p.working).toEqual([]);
    expect(ids(p.recent)).toEqual(["b4", "b5"]);
  });

  it("gives a chat back to the top of Recent when it finishes: its turn's end is its newest activity", () => {
    // b5 worked; its turn ended now, which the store writes as its last activity (store.ts, turn.end)
    const after = { buddy: threads.buddy.map((r) => (r.thread === "b5" ? { ...r, last: 1_000 } : r)) };
    const p = recentParts(after, ["buddy"], {}, () => false, NOW, 3, { working: busy(), group: true });
    expect(p.working).toEqual([]);
    expect(ids(p.recent)).toEqual(["b5", "b1", "b2"]);
  });
});
