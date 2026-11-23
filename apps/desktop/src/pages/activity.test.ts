// The activity log's rules, apart from the page: which events a filter keeps, how they group into days, what a
// customer's message shows and when, and what an export holds. Times are this computer's, as the page's are.
import { afterEach, describe, expect, it } from "vitest";
import { setLang, t } from "../i18n";
import { ACTIVITY_KINDS, OWNER, type ActivityEvent } from "../runtime/mission";
import {
  ALL,
  EXPORT_START,
  exportCsv,
  exportEvents,
  exportReduce,
  filterEvents,
  filterReduce,
  filtersOn,
  groupDays,
  inRange,
  NO_FILTERS,
  selectedEvent,
  textView,
  type ExportState,
  type Filters,
} from "./activity";

const NOW = new Date(2026, 10, 22, 12, 0).getTime();
/** Seconds since the epoch for a moment of November 2026, this computer's time. */
const at = (day: number, h = 9, m = 14) => new Date(2026, 10, day, h, m).getTime() / 1000;
const ev = (over: Partial<ActivityEvent> = {}): ActivityEvent => ({
  id: "e",
  at: at(22),
  who: "nam",
  kind: "msg",
  title: "Nam sent 3 LINE replies about late parcels",
  item: "Replies about late parcels",
  job: "late-parcels",
  approval: "You approved it",
  status: "sent",
  where: "LINE Official Account",
  undo: "No. LINE messages can’t be unsent.",
  note: "To Khun Ploy and 2 others.",
  text: null,
  ...over,
});
const kindLabel = (k: string) => ({ msg: "Messages", money: "Money", post: "Posts", code: "Code", signin: "Sign-ins", settings: "Settings" })[k] ?? k;
const filters = (over: Partial<Filters> = {}): Filters => ({ ...NO_FILTERS, ...over });

afterEach(() => setLang("en"));

describe("a date range", () => {
  it("today is this day on this computer's clock, and nothing before it", () => {
    expect(inRange(at(22, 0, 0), "today", NOW, "", "")).toBe(true);
    expect(inRange(at(22, 11, 59), "today", NOW, "", "")).toBe(true);
    expect(inRange(at(21, 23, 59), "today", NOW, "", "")).toBe(false);
  });

  it("7 days is today and the six days before it; 30 days is today and the twenty-nine before", () => {
    expect(inRange(at(16, 0, 0), "7", NOW, "", "")).toBe(true);
    expect(inRange(at(15, 23, 59), "7", NOW, "", "")).toBe(false);
    expect(inRange(new Date(2026, 9, 24, 8, 0).getTime() / 1000, "30", NOW, "", "")).toBe(true);
    expect(inRange(new Date(2026, 9, 23, 23, 59).getTime() / 1000, "30", NOW, "", "")).toBe(false);
  });

  it("a custom range runs from the start of its first day to the end of its last", () => {
    expect(inRange(at(16, 0, 0), "custom", NOW, "2026-11-16", "2026-11-19")).toBe(true);
    expect(inRange(at(19, 23, 59), "custom", NOW, "2026-11-16", "2026-11-19")).toBe(true);
    expect(inRange(at(20, 0, 0), "custom", NOW, "2026-11-16", "2026-11-19")).toBe(false);
    expect(inRange(at(15, 23, 59), "custom", NOW, "2026-11-16", "2026-11-19")).toBe(false);
  });

  it("a custom range given backwards is the same range, and a side left empty or unreadable is open", () => {
    expect(inRange(at(17), "custom", NOW, "2026-11-19", "2026-11-16")).toBe(true);
    expect(inRange(at(10), "custom", NOW, "", "2026-11-19")).toBe(true);
    expect(inRange(at(21), "custom", NOW, "", "2026-11-19")).toBe(false);
    expect(inRange(at(21), "custom", NOW, "2026-11-19", "")).toBe(true);
    expect(inRange(at(2), "custom", NOW, "16 November", "not a date")).toBe(true);
    // a day that is not on the calendar is not a day
    expect(inRange(at(2), "custom", NOW, "2026-02-31", "")).toBe(true);
  });
});

describe("the filters", () => {
  const events = [
    ev({ id: "a", who: "nam", kind: "msg", title: "Nam sent 3 LINE replies", item: "Replies about late parcels", approval: "You approved it", at: at(22, 9, 14) }),
    ev({ id: "b", who: "pim", kind: "post", title: "Pim posted the jasmine candle photo", item: "Jasmine candle post", approval: "You approved it", at: at(21, 11, 30) }),
    ev({ id: "c", who: OWNER, kind: "settings", title: "You set Nam to Small things alone", item: "Nam’s settings", approval: "Your own change", at: at(21, 17, 30) }),
    ev({ id: "d", who: "ton", kind: "money", title: "Ton closed yesterday’s books", item: "Yesterday’s books", approval: "A routine, no approval needed", at: at(14, 8, 0) }),
  ];
  const ids = (f: Filters) => filterEvents(events, f, NOW, kindLabel).map((e) => e.id);

  it("start with everyone, every kind and the last 7 days, and are not 'on'", () => {
    expect(NO_FILTERS).toEqual({ who: ALL, kind: ALL, range: "7", from: "", to: "", query: "" });
    expect(filtersOn(NO_FILTERS)).toBe(false);
    expect(ids(NO_FILTERS)).toEqual(["a", "b", "c"]);
  });

  it("keep one person's events, the owner's included", () => {
    expect(ids(filters({ who: "pim" }))).toEqual(["b"]);
    expect(ids(filters({ who: OWNER }))).toEqual(["c"]);
  });

  it("keep one kind, and reach further back with a longer range", () => {
    expect(ids(filters({ kind: "money" }))).toEqual([]);
    expect(ids(filters({ kind: "money", range: "30" }))).toEqual(["d"]);
    expect(ids(filters({ range: "today" }))).toEqual(["a"]);
  });

  it("search the title, the item, who approved and the kind's name, in any case and ignoring outer spaces", () => {
    expect(ids(filters({ query: "  JASMINE " }))).toEqual(["b"]);
    expect(ids(filters({ query: "late parcels" }))).toEqual(["a"]);
    expect(ids(filters({ query: "your own change" }))).toEqual(["c"]);
    expect(ids(filters({ query: "posts" }))).toEqual(["b"]);
    expect(ids(filters({ query: "nobody wrote this" }))).toEqual([]);
  });

  it("never search a message's text, shown or not, so a hidden message cannot be found by its words", () => {
    const hidden = ev({ id: "t", text: { body: "ขออภัยที่พัสดุล่าช้านะคะ", private: true } });
    const post = ev({ id: "p", text: { body: "12.12 นี้ เซ็ตของขวัญ", private: false } });
    expect(filterEvents([hidden, post], filters({ query: "พัสดุ" }), NOW, kindLabel)).toEqual([]);
    expect(filterEvents([hidden, post], filters({ query: "เซ็ตของขวัญ" }), NOW, kindLabel)).toEqual([]);
  });

  it("combine, and know when any is on", () => {
    expect(ids(filters({ who: "nam", kind: "post" }))).toEqual([]);
    for (const f of [filters({ who: "nam" }), filters({ kind: "msg" }), filters({ range: "30" }), filters({ range: "custom" }), filters({ query: "x" })]) expect(filtersOn(f)).toBe(true);
    expect(filtersOn(filters({ query: "   " }))).toBe(false);
  });

  it("change one at a time, and clear back to the start", () => {
    let f = NO_FILTERS;
    f = filterReduce(f, { type: "who", who: "pim" });
    f = filterReduce(f, { type: "kind", kind: "post" });
    f = filterReduce(f, { type: "range", range: "custom" });
    f = filterReduce(f, { type: "from", from: "2026-11-16" });
    f = filterReduce(f, { type: "to", to: "2026-11-19" });
    f = filterReduce(f, { type: "query", query: "jasmine" });
    expect(f).toEqual({ who: "pim", kind: "post", range: "custom", from: "2026-11-16", to: "2026-11-19", query: "jasmine" });
    expect(filterReduce(f, { type: "clear" })).toEqual(NO_FILTERS);
  });
});

describe("the days", () => {
  it("group events newest first by this computer's day, naming today and yesterday", () => {
    const list = [ev({ id: "a", at: at(22, 9, 14) }), ev({ id: "b", at: at(22, 8, 0) }), ev({ id: "c", at: at(21, 17, 30) }), ev({ id: "d", at: at(14, 8, 0) })];
    const days = groupDays(list, NOW);
    expect(days.map((d) => [d.when, d.events.map((e) => e.id)])).toEqual([
      ["today", ["a", "b"]],
      ["yesterday", ["c"]],
      ["earlier", ["d"]],
    ]);
    expect(days.map((d) => d.day)).toEqual([new Date(2026, 10, 22).getTime(), new Date(2026, 10, 21).getTime(), new Date(2026, 10, 14).getTime()]);
  });

  it("are none for no events", () => {
    expect(groupDays([], NOW)).toEqual([]);
  });
});

describe("the event the details show", () => {
  const list = [ev({ id: "a" }), ev({ id: "b" })];
  it("is the one picked while it is in the list, else the first, else none", () => {
    expect(selectedEvent(list, "b")?.id).toBe("b");
    expect(selectedEvent(list, "gone")?.id).toBe("a");
    expect(selectedEvent(list, null)?.id).toBe("a");
    expect(selectedEvent([], "a")).toBeNull();
  });
});

describe("a message's text", () => {
  const priv = ev({ id: "t", text: { body: "ขออภัยที่พัสดุล่าช้านะคะ", private: true } });
  const post = ev({ id: "p", text: { body: "12.12 นี้ เซ็ตของขวัญ", private: false } });

  it("says nothing for an event that holds none", () => {
    expect(textView(ev(), new Set())).toEqual({ kind: "none" });
  });

  it("hides a customer's message until the owner shows it, then offers to hide it again", () => {
    expect(textView(priv, new Set())).toEqual({ kind: "hidden" });
    expect(textView(priv, new Set(["other"]))).toEqual({ kind: "hidden" });
    expect(textView(priv, new Set(["t"]))).toEqual({ kind: "shown", private: true, body: "ขออภัยที่พัสดุล่าช้านะคะ", canHide: true });
  });

  it("shows the shop's own post as it is, with nothing to hide", () => {
    expect(textView(post, new Set())).toEqual({ kind: "shown", private: false, body: "12.12 นี้ เซ็ตของขวัญ", canHide: false });
  });
});

describe("the export", () => {
  const words = {
    header: ["Date", "Time", "Who", "Kind", "Event", "Item", "Approved", "Status", "Where", "Can it be undone", "Note", "Text"],
    who: (w: string) => (w === OWNER ? "You" : w.toUpperCase()),
    kind: kindLabel,
    status: (s: string) => s.toUpperCase(),
  };
  const events = [
    ev({ id: "a", at: at(22, 9, 14), text: { body: "ขออภัยที่พัสดุล่าช้านะคะ", private: true } }),
    ev({ id: "b", at: at(21, 11, 30), who: "pim", kind: "post", title: "Pim posted the jasmine candle photo", item: "Jasmine candle post", job: null, status: "posted", text: { body: "เทียนหอมกลิ่นมะลิพร้อมส่งแล้วค่ะ", private: false } }),
    ev({ id: "c", at: at(21, 17, 30), who: OWNER, kind: "settings", title: "=You set the budget, to ฿300", item: "Budget", job: null, status: "changed" }),
    ev({ id: "d", at: at(14, 8, 0), who: "ton", kind: "money", title: "Ton closed yesterday’s books", job: null, status: "checked" }),
  ];
  const start = (over: Partial<ExportState> = {}): ExportState => ({ ...EXPORT_START, ...over });

  it("starts closed, over the last 7 days, with every kind included and customer message text left out", () => {
    expect(EXPORT_START).toEqual({ open: false, range: "7", from: "", to: "", kinds: [...ACTIVITY_KINDS], text: false, note: null });
  });

  it("holds the events in its range and of the kinds chosen, and counts them", () => {
    expect(exportEvents(events, start(), NOW).map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(exportEvents(events, start({ range: "30" }), NOW).map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
    expect(exportEvents(events, start({ range: "today" }), NOW).map((e) => e.id)).toEqual(["a"]);
    expect(exportEvents(events, start({ kinds: ["post", "settings"] }), NOW).map((e) => e.id)).toEqual(["b", "c"]);
    expect(exportEvents(events, start({ kinds: [] }), NOW)).toEqual([]);
    expect(exportEvents(events, start({ range: "custom", from: "2026-11-21", to: "2026-11-21" }), NOW).map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("is one header row and one row per event, a time and a date, the way a spreadsheet reads them", () => {
    const rows = exportCsv(events, start(), NOW, words).split("\r\n");
    expect(rows).toHaveLength(1 + 3);
    expect(rows[0]).toBe("Date,Time,Who,Kind,Event,Item,Approved,Status,Where,Can it be undone,Note,Text");
    expect(rows[1].startsWith("2026-11-22,09:14,NAM,Messages,Nam sent 3 LINE replies about late parcels,Replies about late parcels,You approved it,SENT,LINE Official Account,")).toBe(true);
    // the owner is "You", a status is in the owner's language, and an event that held no text has an empty last field
    expect(rows[3]).toContain(",You,Settings,");
    expect(rows[3].endsWith(",")).toBe(true);
  });

  it("leaves a customer's message text out unless it is chosen, and keeps the shop's own post text", () => {
    const left = exportCsv(events, start(), NOW, words);
    expect(left).not.toContain("ขออภัยที่พัสดุล่าช้านะคะ");
    expect(left).toContain("เทียนหอมกลิ่นมะลิพร้อมส่งแล้วค่ะ");
    const kept = exportCsv(events, start({ text: true }), NOW, words);
    expect(kept).toContain("ขออภัยที่พัสดุล่าช้านะคะ");
    expect(kept).toContain("เทียนหอมกลิ่นมะลิพร้อมส่งแล้วค่ะ");
  });

  it("guards and quotes every field, so what an event says can neither run as a formula nor break a row", () => {
    const row = exportCsv(events, start(), NOW, words).split("\r\n")[3];
    expect(row).toContain(`"'=You set the budget, to ฿300"`);
    const quoted = exportCsv([ev({ note: 'He said "late",\nthen left' })], start(), NOW, words);
    expect(quoted).toContain('"He said ""late"",\nthen left"');
  });

  it("opens, closes, changes its range and dates, picks kinds and the text, and records that saving is not yet possible", () => {
    let x = start();
    x = exportReduce(x, { type: "open" });
    expect(x.open).toBe(true);
    x = exportReduce(x, { type: "range", range: "custom" });
    x = exportReduce(x, { type: "from", from: "2026-11-16" });
    x = exportReduce(x, { type: "to", to: "2026-11-19" });
    x = exportReduce(x, { type: "kind", kind: "msg" });
    expect(x.kinds).toEqual(ACTIVITY_KINDS.filter((k) => k !== "msg"));
    x = exportReduce(x, { type: "kind", kind: "msg" });
    expect(x.kinds).toEqual([...ACTIVITY_KINDS]);
    x = exportReduce(x, { type: "text" });
    expect(x.text).toBe(true);
    x = exportReduce(x, { type: "note", note: "not_yet" });
    expect(x.note).toBe("not_yet");
    // any change after a refusal takes the refusal's note away, and closing starts the next opening clean
    expect(exportReduce(x, { type: "text" }).note).toBeNull();
    expect(exportReduce(x, { type: "close" })).toEqual({ ...x, open: false, note: null });
  });

  it("starts the customer's text off again every time the dialog opens, so a tick is never carried over", () => {
    const x = exportReduce(exportReduce(start(), { type: "text" }), { type: "close" });
    expect(x.text).toBe(true);
    expect(exportReduce(x, { type: "open" }).text).toBe(false);
  });

  it("has words for every kind", () => {
    setLang("en");
    for (const k of ACTIVITY_KINDS) expect(t(`act.kind.${k}` as never).trim()).not.toBe("");
  });
});
