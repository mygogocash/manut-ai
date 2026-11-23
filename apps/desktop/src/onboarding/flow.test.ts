// The first-run setup's rules: whether it shows, where it opens, how its steps move, what each step needs before Next
// moves on, and which members its last step introduces.
import { describe, expect, it } from "vitest";
import { EMPTY_SHOP, type ShopProfile } from "./shop";
import {
  firstRunEntry,
  flowReduce,
  isFirstRunOpen,
  practiceTeam,
  problemsOf,
  radioMove,
  startFlow,
  stepMark,
  STEPS,
  type FlowEvent,
  type FlowState,
} from "./flow";

const run = (s: FlowState, ...events: FlowEvent[]) => events.reduce(flowReduce, s);
const fresh = () => startFlow("welcome", EMPTY_SHOP);
const shop = (over: Partial<ShopProfile> = {}): ShopProfile => ({ ...EMPTY_SHOP, shop: "Baan Mali", places: ["line", "shopee"], ...over });

describe("whether the setup shows", () => {
  it("opens on Welcome until the person has finished or skipped it once, then never on its own", () => {
    expect(firstRunEntry(null)).toBe("welcome");
    expect(firstRunEntry("")).toBe("welcome");
    expect(firstRunEntry("0")).toBe("welcome");
    expect(firstRunEntry("1")).toBeNull();
  });

  it("is open while it holds a screen", () => {
    expect(isFirstRunOpen({ firstRun: fresh() })).toBe(true);
    expect(isFirstRunOpen({ firstRun: null })).toBe(false);
  });

  it("opens from Settings on Your shop, holding what was saved", () => {
    const saved = shop({ person: "Fon", main: "line" });
    expect(startFlow("shop", saved)).toEqual({ screen: "shop", draft: saved, problems: [] });
  });
});

describe("the steps", () => {
  it("are the canvas's three, after Welcome", () => {
    expect(STEPS).toEqual(["shop", "channel", "team"]);
  });

  it("go Welcome, Your shop, One channel, Your team with Next, and back one at a time to Welcome", () => {
    let s = run(fresh(), { type: "next" });
    expect(s.screen).toBe("shop");
    s = run(s, { type: "edit", field: "shop", value: "Baan Mali" }, { type: "place", channel: "line" }, { type: "next" });
    expect(s.screen).toBe("channel");
    s = run(s, { type: "next" });
    expect(s.screen).toBe("team");
    // the last step ends the setup itself (the store's firstRunEnd): Next there moves nowhere
    expect(run(s, { type: "next" })).toBe(s);
    expect(run(s, { type: "back" }).screen).toBe("channel");
    expect(run(s, { type: "back" }, { type: "back" }).screen).toBe("shop");
    expect(run(s, { type: "back" }, { type: "back" }, { type: "back" }).screen).toBe("welcome");
    const w = run(s, { type: "back" }, { type: "back" }, { type: "back" });
    expect(run(w, { type: "back" })).toBe(w);
  });

  it("keep what was typed when going back and forth", () => {
    const s = run(fresh(), { type: "next" }, { type: "edit", field: "person", value: "Fon" }, { type: "back" }, { type: "next" });
    expect(s.draft.person).toBe("Fon");
  });

  it("mark the steps before the current one done and the current one now", () => {
    expect(STEPS.map((st) => stepMark(st, "welcome"))).toEqual(["", "", ""]);
    expect(STEPS.map((st) => stepMark(st, "shop"))).toEqual(["now", "", ""]);
    expect(STEPS.map((st) => stepMark(st, "channel"))).toEqual(["done", "now", ""]);
    expect(STEPS.map((st) => stepMark(st, "team"))).toEqual(["done", "done", "now"]);
  });
});

describe("Your shop", () => {
  it("needs the shop's name and at least one place before Next moves on; the person's name and what it sells may wait", () => {
    expect(problemsOf("shop", EMPTY_SHOP)).toEqual(["shop", "places"]);
    expect(problemsOf("shop", shop({ shop: "   " }))).toEqual(["shop"]);
    expect(problemsOf("shop", shop({ places: [] }))).toEqual(["places"]);
    expect(problemsOf("shop", shop())).toEqual([]);
  });

  it("stays put on a refused Next and says what is missing; fixing a field clears its own problem only", () => {
    let s = run(fresh(), { type: "next" }, { type: "next" });
    expect(s).toMatchObject({ screen: "shop", problems: ["shop", "places"] });
    s = run(s, { type: "edit", field: "shop", value: "Baan Mali" });
    expect(s.problems).toEqual(["places"]);
    s = run(s, { type: "place", channel: "shopee" });
    expect(s.problems).toEqual([]);
    // a problem is not shown before Next is pressed
    expect(run(fresh(), { type: "next" }, { type: "edit", field: "shop", value: "" }).problems).toEqual([]);
  });

  it("keeps typed words as they are while typing, spaces too, up to each field's limit", () => {
    const s = run(fresh(), { type: "next" }, { type: "edit", field: "shop", value: "Baan " }, { type: "edit", field: "sells", value: "x".repeat(500) });
    expect(s.draft.shop).toBe("Baan ");
    expect(s.draft.sells).toHaveLength(160);
  });

  it("toggles places in the canvas's order, and taking the main channel's place away takes its pick with it", () => {
    let s = run(startFlow("shop", shop({ places: ["line", "shopee"], main: "shopee" })), { type: "place", channel: "facebook" });
    expect(s.draft).toMatchObject({ places: ["line", "shopee", "facebook"], main: "shopee" });
    s = run(s, { type: "place", channel: "shopee" });
    expect(s.draft).toMatchObject({ places: ["line", "facebook"], main: null });
  });
});

describe("One channel", () => {
  it("picks the one place a shop sells in by itself, and asks when there are more", () => {
    const one = run(fresh(), { type: "next" }, { type: "edit", field: "shop", value: "Baan Mali" }, { type: "place", channel: "line" }, { type: "next" });
    expect(one.draft.main).toBe("line");
    const two = run(startFlow("shop", shop()), { type: "next" });
    expect(two).toMatchObject({ screen: "channel", draft: { main: null } });
  });

  it("needs a pick before Next moves on, and takes only one of the shop's own places", () => {
    let s = run(startFlow("shop", shop()), { type: "next" }, { type: "next" });
    expect(s).toMatchObject({ screen: "channel", problems: ["main"] });
    expect(run(s, { type: "main", channel: "lazada" })).toBe(s);
    s = run(s, { type: "main", channel: "shopee" });
    expect(s).toMatchObject({ draft: { main: "shopee" }, problems: [] });
    expect(run(s, { type: "next" }).screen).toBe("team");
  });

  it("moves the pick with the arrow keys, wrapping, as a radio group does", () => {
    const list = ["line", "shopee", "facebook"] as const;
    expect(radioMove(list, "line", "ArrowDown")).toBe("shopee");
    expect(radioMove(list, "line", "ArrowRight")).toBe("shopee");
    expect(radioMove(list, "facebook", "ArrowDown")).toBe("line");
    expect(radioMove(list, "line", "ArrowUp")).toBe("facebook");
    expect(radioMove(list, "shopee", "ArrowLeft")).toBe("line");
    expect(radioMove(list, null, "ArrowDown")).toBe("line");
    expect(radioMove(list, null, "ArrowUp")).toBe("facebook");
    expect(radioMove(list, "shopee", "Home")).toBe("line");
    expect(radioMove(list, "line", "End")).toBe("facebook");
    expect(radioMove(list, "line", "Enter")).toBeNull();
    expect(radioMove([], null, "ArrowDown")).toBeNull();
  });
});

describe("Your team", () => {
  it("introduces Nam, Pim and Ton in the canvas's order, as the runtime lists them, and leaves out who it does not list", () => {
    const bots = ["buddy", "ton", "kit", "nam", "pim"].map((name) => ({ name }));
    expect(practiceTeam(bots).map((m) => [m.bot.name, m.role])).toEqual([
      ["nam", "sales"],
      ["pim", "content"],
      ["ton", "books"],
    ]);
    expect(practiceTeam([{ name: "buddy" }, { name: "pim" }]).map((m) => m.bot.name)).toEqual(["pim"]);
    expect(practiceTeam([])).toEqual([]);
  });

  it("needs nothing before the setup ends", () => {
    expect(problemsOf("team", EMPTY_SHOP)).toEqual([]);
  });
});
