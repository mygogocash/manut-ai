// The activity log, drawn with react-dom/server as smoke.test.tsx draws the first screen. The events are the demo runtime's
// own, started at 10:00 on Sunday 22 November, so what the page shows is what the canvas's Activity board shows, and the
// filters, the details, the customer's hidden message and the export are each drawn in their states.
import { afterEach, describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { setLang } from "../i18n";
import { OWNER, type ActivityEvent } from "../runtime/mission";
import { MockHost, MockRuntime } from "../runtime/mock";
import { EXPORT_START, NO_FILTERS, type ExportState, type Filters } from "./activity";
import { LOADING, type Load } from "./load";
import { ActivityView, activityWords, csvName, downloadCsv, type ActivityViewProps } from "./ActivityPage";
import { saveCsv } from "./saveFile";

const BOOT = new Date(2026, 10, 22, 10, 0).getTime() / 1000;
const NOW = BOOT * 1000;

async function demoLog() {
  const rt = new MockRuntime(new MockHost({ now: () => BOOT }));
  await rt.connect();
  return rt.request("activity.list", {});
}

const words = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const count = (html: string, needle: string) => html.split(needle).length - 1;
/** What follows the opening tag that carries `testid`. */
const after = (html: string, testid: string) => html.slice(html.indexOf(`data-testid="${testid}"`)).replace(/^[^>]*>/, "");
const noop = () => {};

const PEOPLE = [
  { id: "buddy", label: "Buddy" },
  { id: "nam", label: "Nam" },
  { id: "pim", label: "Pim" },
  { id: "ton", label: "Ton" },
  { id: "kit", label: "Kit" },
  { id: OWNER, label: "You" },
];
const WHO: Record<string, { name: string; role: string }> = {
  buddy: { name: "Buddy", role: "Your assistant" },
  nam: { name: "Nam", role: "Sales chat" },
  pim: { name: "Pim", role: "Content" },
  ton: { name: "Ton", role: "Books" },
  kit: { name: "Kit", role: "Engineer" },
  [OWNER]: { name: "You", role: "Fon, Baan Mali" },
};

type Ready = Load<{ events: ActivityEvent[]; keptMonths: number }>;

function draw(over: Partial<ActivityViewProps> & { load: Ready }, filters: Partial<Filters> = {}, exporting: Partial<ExportState> = {}) {
  setLang("en");
  return renderToString(
    <ActivityView
      nowMs={NOW}
      filters={{ ...NO_FILTERS, ...filters }}
      onFilter={noop}
      people={PEOPLE}
      face={() => null}
      person={(who) => WHO[who] ?? { name: who, role: "" }}
      pickedId={null}
      onPick={noop}
      shown={new Set()}
      onShow={noop}
      onHide={noop}
      exporting={{ ...EXPORT_START, ...exporting }}
      onExport={noop}
      onDownload={noop}
      onBack={noop}
      onOpenJob={noop}
      {...over}
    />,
  );
}

afterEach(() => setLang("en"));

describe("the activity log while it waits and when it cannot be shown", () => {
  it("says it is loading, in a status the page announces, with History's tabs to leave by", () => {
    const html = draw({ load: LOADING });
    expect(html).toContain('data-testid="page-activity"');
    expect(html).toMatch(/role="status"[^>]*data-testid="act-loading"|data-testid="act-loading"[^>]*role="status"/);
    expect(words(html)).toContain("Loading the activity log");
    expect(words(html)).toContain("Jobs and chats");
    expect(html).not.toContain('data-testid="act-count"');
  });

  it("says why when the runtime cannot show it, in the runtime's own words", () => {
    const html = draw({ load: { kind: "unavailable", code: "not_yet", message: "Not yet: Connected mode cannot show this for now. It comes in a later version." } });
    expect(html).toMatch(/role="alert"[^>]*data-testid="act-unavailable"|data-testid="act-unavailable"[^>]*role="alert"/);
    expect(words(html)).toContain("The activity log cannot be shown");
    expect(words(html)).toContain("Not yet: Connected mode cannot show this for now. It comes in a later version.");
    expect(html).not.toContain('data-testid="act-row"');
  });

  it("says what will be here when the shop has no activity at all", () => {
    const html = draw({ load: { kind: "ready", value: { events: [], keptMonths: 12 } } });
    expect(html).toContain('data-testid="act-empty"');
    expect(words(html)).toContain("No activity yet");
    expect(words(html)).toContain("What the team does, and what you change, is listed here, newest first.");
    expect(html).not.toContain('data-testid="act-count"');
  });
});

describe("the activity log as the canvas draws it", () => {
  it("has History's two tabs with the log current, a search box named for what it does, and Export CSV", async () => {
    const html = draw({ load: { kind: "ready", value: await demoLog() } });
    const text = words(html);
    expect(html).toMatch(/<h1[^>]*class="vh"[^>]*>Activity log<\/h1>/);
    expect(html).toMatch(/role="group" aria-label="History"/);
    expect(html).toMatch(/<button[^>]*data-testid="act-tab-jobs"[^>]*>Jobs and chats<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-current="page"[^>]*data-testid="act-tab-log"[^>]*>Activity log<\/button>/);
    expect(html).toMatch(/<label[^>]*for="act-find"[^>]*>Search the activity log<\/label>/);
    expect(html).toMatch(/<input[^>]*id="act-find"[^>]*placeholder="Search events, orders, branches"[^>]*data-testid="act-find"/);
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*data-testid="act-export"[^>]*>.*Export CSV<\/button>/);
    expect(text).toContain("Kept for 12 months, then deleted for good.");
  });

  it("offers filters for who, kind and date, each pressed where it stands, and counts what they keep", async () => {
    const html = draw({ load: { kind: "ready", value: await demoLog() } });
    const text = words(html);
    expect(text).toMatch(/Who Everyone Buddy Nam Pim Ton Kit You/);
    expect(text).toMatch(/Kind All kinds Messages Money Posts Code Sign-ins Settings/);
    expect(text).toMatch(/Date Today 7 days 30 days Custom/);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="act-who-all"/);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="act-kind-all"/);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="act-range-7"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-testid="act-range-30"/);
    // twelve of the fourteen events fall in the last seven days, and no filter is on to clear
    expect(words(after(html, "act-count"))).toMatch(/^ *12 events in the last 7 days/);
    expect(html).not.toContain('data-testid="act-clear"');
  });

  it("groups the events by day, newest first, with the time, who, what, the kind, the item, who approved and how it ended", async () => {
    const html = draw({ load: { kind: "ready", value: await demoLog() } });
    const text = words(html);
    expect(text.indexOf("Today Sunday 22 November")).toBeLessThan(text.indexOf("Yesterday Saturday 21 November"));
    expect(text.indexOf("Yesterday Saturday 21 November")).toBeLessThan(text.indexOf("Friday 20 November"));
    expect(count(html, 'data-testid="act-row"')).toBe(12);
    expect(text).toContain("09:30");
    expect(text).toContain("Kit pushed 2 changes to the PromptPay branch Code kit/promptpay-qr No approval needed Checked");
    expect(text).toContain("Nam sent 3 LINE replies about late parcels Messages Replies about late parcels You approved it Sent");
    expect(html).toMatch(/<span class="tag warn">Needs you<\/span>/);
    expect(html).toMatch(/<span class="tag ok">Posted<\/span>/);
    expect(html).toMatch(/<span class="tag">Changed<\/span>/);
    // the events before the seven days are not in the list
    expect(text).not.toContain("You added the Carrier portal sign-in to the vault");
  });
});

describe("an event's details", () => {
  it("open on the first event until another is picked, saying who, when, what kind, the item, who approved, where and whether it can be undone", async () => {
    const html = draw({ load: { kind: "ready", value: await demoLog() } });
    const text = words(after(html, "act-details"));
    expect(html).toMatch(/<aside[^>]*id="act-detail"[^>]*aria-label="Event details"/);
    expect(text).toContain("Event details");
    expect(text).toContain("Kit Engineer");
    expect(text).toContain("Kit pushed 2 changes to the PromptPay branch");
    expect(text).toMatch(/When Today, Sunday 22 November at 09:30/);
    expect(text).toMatch(/Kind Code/);
    expect(text).toMatch(/Item kit\/promptpay-qr/);
    expect(text).toMatch(/Approved No approval needed/);
    expect(text).toMatch(/Where GitHub, project baanmali-preorder/);
    expect(text).toMatch(/Can it be undone Yes\. The branch keeps every earlier version\./);
    expect(text).toContain("14 tests passed. Customers see nothing until you put the page live.");
    // an item that is not a job is not a link, so no button pretends it opens something
    expect(html).not.toContain('data-testid="act-open-job"');
  });

  it("marks the picked row, and opens a job when the event's item is one", async () => {
    const html = draw({ load: { kind: "ready", value: await demoLog() }, pickedId: "e2" });
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="act-pick-e2"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-testid="act-pick-e1"/);
    expect(words(after(html, "act-details"))).toContain("Nam Sales chat");
    expect(html).toMatch(/<button[^>]*data-testid="act-open-job"[^>]*>Open Replies about late parcels<\/button>/);
  });

  it("hides a customer's message, and says it stays out of exports unless chosen", async () => {
    const html = draw({ load: { kind: "ready", value: await demoLog() }, pickedId: "e2" });
    const text = words(after(html, "act-details"));
    expect(text).toContain("Customer message text is hidden");
    expect(text).toContain("It stays out of exports unless you choose it.");
    expect(html).toMatch(/<button[^>]*data-testid="act-show"[^>]*>Show the message<\/button>/);
    // the words themselves are nowhere in the page, hidden or not
    expect(html).not.toContain("ขออภัยที่พัสดุล่าช้านะคะ");
  });

  it("shows the message once the owner asks, as it was sent, with a way to hide it again", async () => {
    const html = draw({ load: { kind: "ready", value: await demoLog() }, pickedId: "e2", shown: new Set(["e2"]) });
    const text = words(after(html, "act-details"));
    expect(text).toContain("The message as sent");
    expect(html).toContain("ขออภัยที่พัสดุล่าช้านะคะ");
    expect(html).toMatch(/<button[^>]*data-testid="act-hide"[^>]*>Hide<\/button>/);
    expect(html).not.toContain('data-testid="act-show"');
    expect(text).not.toContain("Customer message text is hidden");
  });

  it("shows the shop's own post text as it is, with nothing to hide", async () => {
    const html = draw({ load: { kind: "ready", value: await demoLog() }, pickedId: "e7" });
    expect(words(after(html, "act-details"))).toContain("Post text");
    expect(html).toContain("12.12 นี้ เซ็ตของขวัญปีใหม่กลับมาแล้วค่ะ");
    expect(html).not.toContain('data-testid="act-hide"');
    expect(html).not.toContain('data-testid="act-show"');
  });

  it("falls back to the first event listed when the picked one is no longer there", async () => {
    const html = draw({ load: { kind: "ready", value: await demoLog() }, pickedId: "e13" });
    expect(words(after(html, "act-details"))).toContain("Kit pushed 2 changes");
  });
});

describe("the filters at work", () => {
  it("keep one person's events, and say how many", async () => {
    const html = draw({ load: { kind: "ready", value: await demoLog() } }, { who: "nam" });
    expect(count(html, 'data-testid="act-row"')).toBe(4);
    expect(words(after(html, "act-count"))).toMatch(/^ *4 events in the last 7 days/);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="act-who-nam"/);
    expect(html).toMatch(/<button[^>]*data-testid="act-clear"[^>]*>Clear filters<\/button>/);
  });

  it("say one event, not one events, and name today and a custom range in words", async () => {
    const value = await demoLog();
    expect(words(after(draw({ load: { kind: "ready", value } }, { kind: "money" }), "act-count"))).toMatch(/^ *1 event in the last 7 days/);
    expect(words(after(draw({ load: { kind: "ready", value } }, { range: "today" }), "act-count"))).toMatch(/^ *6 events today/);
    expect(words(after(draw({ load: { kind: "ready", value } }, { range: "30" }), "act-count"))).toMatch(/^ *14 events in the last 30 days/);
    const custom = draw({ load: { kind: "ready", value } }, { range: "custom", from: "2026-11-16", to: "2026-11-19" });
    expect(words(after(custom, "act-count"))).toMatch(/^ *2 events from Nov 16 to Nov 19/);
    expect(custom).toMatch(/<input[^>]*id="act-from"[^>]*type="date"[^>]*value="2026-11-16"/);
    expect(custom).toMatch(/<input[^>]*id="act-to"[^>]*type="date"[^>]*value="2026-11-19"/);
    expect(draw({ load: { kind: "ready", value } })).not.toContain('id="act-from"');
  });

  it("search by words, and say nothing matches, in the canvas's words, with a way to clear", async () => {
    const value = await demoLog();
    const found = draw({ load: { kind: "ready", value } }, { query: "jasmine" });
    expect(found).toContain('value="jasmine"');
    expect(count(found, 'data-testid="act-row"')).toBe(1);
    const none = draw({ load: { kind: "ready", value } }, { who: "kit", kind: "post" });
    const text = words(none);
    expect(none).toContain('data-testid="act-none"');
    expect(text).toContain("Nothing matches these filters");
    expect(text).toContain("Try another person, kind or date, or clear the search.");
    expect(none).toMatch(/<button[^>]*data-testid="act-clear-empty"[^>]*>Clear filters<\/button>/);
    expect(none).not.toContain('data-testid="act-row"');
    expect(words(after(none, "act-count"))).toMatch(/^ *0 events in the last 7 days/);
  });
});

describe("Export to CSV", () => {
  it("stays closed until it is asked for", async () => {
    const html = draw({ load: { kind: "ready", value: await demoLog() } });
    expect(html).not.toContain('role="dialog"');
  });

  it("asks for a date range, what is included and whether to include customer message text, which is left out unless ticked", async () => {
    const html = draw({ load: { kind: "ready", value: await demoLog() } }, {}, { open: true });
    const text = words(after(html, "act-export-dialog"));
    expect(html).toMatch(/<div[^>]*role="dialog"[^>]*aria-labelledby="exp-title"[^>]*data-testid="act-export-dialog"/);
    expect(text).toContain("Export to CSV");
    expect(text).toContain("One row per event: the time, who did it, what happened, the item and who approved it.");
    expect(text).toMatch(/Date range Today 7 days 30 days Custom/);
    expect(text).toMatch(/What is included Messages Money Posts Code Sign-ins Settings/);
    expect(text).toContain("Include customer message text");
    expect(text).toContain("Left out unless you tick this. Every other detail of each event is included.");
    // the customer's text is not ticked, and every kind is
    expect(html).toMatch(/aria-checked="false"[^>]*data-testid="act-export-text"/);
    expect(count(html, 'aria-checked="true"')).toBe(6);
    expect(text).toMatch(/12 rows in the file/);
    expect(text).toContain("Cancel");
    expect(html).toMatch(/<button[^>]*data-testid="act-export-go"[^>]*>Download CSV<\/button>/);
  });

  it("shows a ticked customer text, a custom range's dates and a changed count", async () => {
    const value = await demoLog();
    const html = draw({ load: { kind: "ready", value } }, {}, { open: true, text: true, range: "custom", from: "2026-11-21", to: "2026-11-21", kinds: ["msg", "post"] });
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="act-export-text"/);
    expect(html).toMatch(/<input[^>]*id="exp-from"[^>]*type="date"[^>]*value="2026-11-21"/);
    expect(words(after(html, "act-export-dialog"))).toMatch(/2 rows in the file/);
  });

  it("asks for a kind when none is chosen, and does not let the file be made", async () => {
    const html = draw({ load: { kind: "ready", value: await demoLog() } }, {}, { open: true, kinds: [] });
    expect(words(after(html, "act-export-dialog"))).toContain("Choose at least one kind");
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*data-testid="act-export-go"/);
  });

  it("says saving a file is not yet possible here, honestly, once Download CSV is pressed", async () => {
    const html = draw({ load: { kind: "ready", value: await demoLog() } }, {}, { open: true, note: "not_yet" });
    expect(html).toMatch(/role="status"[^>]*data-testid="act-export-notyet"|data-testid="act-export-notyet"[^>]*role="status"/);
    expect(words(html)).toContain("Not yet: this app cannot save a file yet, so nothing was exported.");
  });
});

describe("making the file", () => {
  const ctx = async () => {
    const { events } = await demoLog();
    return { events, words: activityWords((who) => WHO[who]?.name ?? who) };
  };

  it("names the file for the day it was made", () => {
    expect(csvName(NOW)).toBe("manut-activity-2026-11-22.csv");
  });

  it("hands the saver the file with the customer's message left out, and asks nothing of it when no kind is chosen", async () => {
    const { events, words } = await ctx();
    const saved: { name: string; text: string }[] = [];
    const save = async (name: string, text: string) => {
      saved.push({ name, text });
      return "saved" as const;
    };
    expect(await downloadCsv(events, EXPORT_START, NOW, words, save)).toBe("saved");
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("manut-activity-2026-11-22.csv");
    expect(saved[0].text.split("\r\n")).toHaveLength(1 + 12);
    expect(saved[0].text.startsWith("Date,Time,Who,Kind,Event,Item,Approved,Status,Where,Can it be undone,Note,Text\r\n2026-11-22,09:30,Kit,Code,")).toBe(true);
    expect(saved[0].text).not.toContain("ขออภัยที่พัสดุล่าช้านะคะ");
    expect(saved[0].text).toContain("12.12 นี้ เซ็ตของขวัญปีใหม่กลับมาแล้วค่ะ");
    expect(await downloadCsv(events, { ...EXPORT_START, kinds: [] }, NOW, words, save)).toBe("nothing");
    expect(saved).toHaveLength(1);
  });

  it("includes the customer's message only when that export asks for it", async () => {
    const { events, words } = await ctx();
    let text = "";
    await downloadCsv(events, { ...EXPORT_START, text: true }, NOW, words, async (_name, body) => {
      text = body;
      return "saved";
    });
    expect(text).toContain("ขออภัยที่พัสดุล่าช้านะคะ");
  });

  it("is not yet possible in the desktop shell, which has no save dialog or file writer, and says so", async () => {
    const { events, words } = await ctx();
    expect(await saveCsv("x.csv", "a,b")).toBe("not_yet");
    expect(await downloadCsv(events, EXPORT_START, NOW, words)).toBe("not_yet");
  });
});
