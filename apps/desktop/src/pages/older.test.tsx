// Show older on History and the activity log (older.ts, ShowOlder.tsx; docs/runtime-adapter.md, "Older tasks"): the words for each
// state of the list and of the press, in all four languages; the line and the button drawn under each list; the press itself, which
// asks for the next page one at a time, has the page read its list again once it is read, and says in the runtime's own words when it
// was not; and Practice, whose lists never say there is more. Drawn with react-dom/server as the pages beside it are.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { LANGS, setLang, t } from "../i18n";
import type { BridgeError } from "../lib/protocol";
import { OWNER, type ActivityEvent, type OlderState } from "../runtime/mission";
import { MockHost, MockRuntime } from "../runtime/mock";
import { createStore } from "../state/store";
import { ActivityView, type ActivityViewProps } from "./ActivityPage";
import { EXPORT_START, NO_FILTERS, type Filters } from "./activity";
import { HistoryView, historyDays } from "./HistoryPage";
import { LOADING, type Load } from "./load";
import { OLDER_IDLE, olderPress, olderWords, type OlderUi, type OlderView } from "./older";
import { ShowOlder } from "./ShowOlder";

const BOOT = new Date(2026, 10, 22, 10, 0).getTime() / 1000;
const NOW = BOOT * 1000;
const noop = () => {};

const words = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const reading: OlderUi = { step: "reading", message: null };
const failed = (message: string | null): OlderUi => ({ step: "failed", message });
const view = (state: OlderState, ui: OlderUi = OLDER_IDLE, onShow: () => void = noop): OlderView => ({ state, ui, onShow });

afterEach(() => {
  setLang("en");
  vi.useRealTimers();
});

describe("the words for Show older", () => {
  it("says there is older work and offers Show older; says it is reading; says everything is shown with no button; and on a failure says why and offers Try again", () => {
    expect(olderWords("more", OLDER_IDLE)).toEqual({ line: "Only the newest work is shown here. There is older work.", button: "Show older", alert: false });
    expect(olderWords("more", reading)).toEqual({ line: "Reading older work…", button: "Show older", alert: false });
    expect(olderWords("end", OLDER_IDLE)).toEqual({ line: "That is everything. There is no older work.", button: null, alert: false });
    // a failure says why in the runtime's own words (offline: it needs a connection), and what is shown has not changed
    expect(olderWords("more", failed(t("older.offline")))).toEqual({ line: "Show older needs a connection. What is shown here has not changed.", button: "Try again", alert: true });
    expect(olderWords("more", failed(t("older.failed")))).toEqual({ line: "Older work could not be read. What is shown here has not changed.", button: "Try again", alert: true });
    expect(olderWords("more", failed(null)).line).toBe(t("older.failed"));
    // once everything is shown there is nothing to read, whatever the press last said
    expect(olderWords("end", failed("x")).button).toBeNull();
  });

  it("says each of them in English, Korean, Japanese and Chinese, each in words of its own", () => {
    const say = (lang: (typeof LANGS)[number]) => {
      setLang(lang);
      return [olderWords("more", OLDER_IDLE), olderWords("more", reading), olderWords("end", OLDER_IDLE), olderWords("more", failed(null))].flatMap((w) => [w.line, w.button ?? ""]).concat(t("older.offline"));
    };
    const english = say("en");
    for (const lang of LANGS.filter((l) => l !== "en")) {
      const said = say(lang);
      expect(said, lang).toHaveLength(english.length);
      said.forEach((line, i) => {
        if (english[i] === "") return expect(line, `${lang} ${i}`).toBe("");
        expect(line.trim(), `${lang} ${i}`).not.toBe("");
        expect(line, `${lang} ${i}`).not.toBe(english[i]);
      });
    }
    setLang("ko");
    expect(olderWords("more", OLDER_IDLE).button).toBe("이전 작업 보기");
    setLang("ja");
    expect(olderWords("more", OLDER_IDLE).button).toBe("古い仕事を表示");
    setLang("zh");
    expect(olderWords("more", OLDER_IDLE).button).toBe("显示更早的");
  });
});

describe("Show older, drawn", () => {
  it("draws a line and a button that says Show older, as a status", () => {
    const html = renderToString(<ShowOlder view={view("more")} />);
    expect(html).toContain('data-testid="older"');
    expect(html).toContain('data-state="idle"');
    expect(html).toMatch(/<p role="status" data-testid="older-line">Only the newest work is shown here\. There is older work\.<\/p>/);
    expect(html).toMatch(/<button[^>]*data-testid="older-show"[^>]*>Show older<\/button>/);
    expect(html).toContain('aria-disabled="false"');
    expect(html).not.toContain("aria-busy");
  });

  it("holds the button, but keeps it where it is, while the page is read", () => {
    const html = renderToString(<ShowOlder view={view("more", reading)} />);
    expect(html).toContain('data-state="reading"');
    expect(words(html)).toContain("Reading older work…");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain(" disabled");
  });

  it("says what went wrong as an alert, with Try again", () => {
    const html = renderToString(<ShowOlder view={view("more", failed(t("older.offline")))} />);
    expect(html).toContain('data-state="failed"');
    expect(html).toMatch(/<p role="alert" data-testid="older-line">Show older needs a connection\./);
    expect(html).toMatch(/<button[^>]*data-testid="older-show"[^>]*>Try again<\/button>/);
  });

  it("says everything is shown, with no button to press", () => {
    const html = renderToString(<ShowOlder view={view("end")} />);
    expect(html).toContain('data-state="end"');
    expect(words(html)).toBe("That is everything. There is no older work.");
    expect(html).not.toContain("<button");
  });
});

describe("under History's list", () => {
  async function demo() {
    const store = createStore(new MockRuntime(new MockHost({ now: () => BOOT })), { firstRoster: "all", hiddenBots: () => [], resume: () => null, now: () => NOW });
    await store.actions.init();
    store.actions.firstRunEnd();
    const { jobs, ...rest } = await store.actions.missionJobs();
    return { store, jobs, rest };
  }

  it("is drawn after the last row of the list, with the button, when the shop has older work", async () => {
    const { store, jobs } = await demo();
    const days = historyDays(store.getSnapshot(), "", NOW, jobs);
    const html = renderToString(<HistoryView days={days} query="" hasThreads onQuery={noop} older={view("more")} />);
    expect(html.lastIndexOf('data-testid="history-row"')).toBeLessThan(html.indexOf('data-testid="older"'));
    expect(words(html)).toContain("Only the newest work is shown here. There is older work. Show older");
  });

  it("is drawn when what was searched for is not among what is shown, since older work may hold it, and with the list empty of matches", async () => {
    const { store, jobs } = await demo();
    const days = historyDays(store.getSnapshot(), "no such work", NOW, jobs);
    expect(days).toEqual([]);
    const html = renderToString(<HistoryView days={days} query="no such work" hasThreads onQuery={noop} older={view("more")} />);
    expect(html).toContain('data-testid="history-none"');
    expect(html.indexOf('data-testid="history-none"')).toBeLessThan(html.indexOf('data-testid="older"'));
  });

  it("says everything is shown once the last page is read", async () => {
    const { store, jobs } = await demo();
    const html = renderToString(<HistoryView days={historyDays(store.getSnapshot(), "", NOW, jobs)} query="" hasThreads onQuery={noop} older={view("end")} />);
    expect(words(html)).toContain("That is everything. There is no older work.");
    expect(html).not.toContain('data-testid="older-show"');
  });

  it("is not drawn for a list that says nothing: Practice's sample shop has 6 jobs, so no older work, and it is as it was", async () => {
    const { store, jobs, rest } = await demo();
    expect(jobs.length).toBeLessThanOrEqual(50);
    expect(rest).toEqual({});
    const days = historyDays(store.getSnapshot(), "", NOW, jobs);
    const html = renderToString(<HistoryView days={days} query="" hasThreads onQuery={noop} onActivity={noop} />);
    expect(html).not.toContain('data-testid="older');
    expect(html).not.toContain("Show older");
    expect(html).toContain('data-testid="history-row"');
  });

  it("is not drawn in the empty state either", () => {
    const html = renderToString(<HistoryView days={[]} query="" hasThreads={false} onQuery={noop} />);
    expect(html).toContain('data-testid="history-empty"');
    expect(html).not.toContain('data-testid="older"');
  });
});

describe("under the activity log's list", () => {
  const PEOPLE = [
    { id: "buddy", label: "Buddy" },
    { id: "nam", label: "Nam" },
    { id: OWNER, label: "You" },
  ];
  type Ready = Load<{ events: ActivityEvent[]; keptMonths: number | null; older?: OlderState }>;

  const draw = (over: Partial<ActivityViewProps> & { load: Ready }, filters: Partial<Filters> = {}) => {
    setLang("en");
    return renderToString(
      <ActivityView
        nowMs={NOW}
        filters={{ ...NO_FILTERS, ...filters }}
        onFilter={noop}
        people={PEOPLE}
        face={() => null}
        person={(who) => ({ name: who, role: "" })}
        pickedId={null}
        onPick={noop}
        shown={new Set()}
        onShow={noop}
        onHide={noop}
        exporting={EXPORT_START}
        onExport={noop}
        onDownload={noop}
        onBack={noop}
        onOpenJob={noop}
        {...over}
      />,
    );
  };
  async function demoLog() {
    const rt = new MockRuntime(new MockHost({ now: () => BOOT }));
    await rt.connect();
    return rt.request("activity.list", {});
  }

  it("is drawn under the last day of events, with the button, when the shop has older work", async () => {
    const log = await demoLog();
    const html = draw({ load: { kind: "ready", value: { ...log, older: "more" } }, older: view("more") });
    expect(html.lastIndexOf('data-testid="act-row"')).toBeLessThan(html.indexOf('data-testid="older"'));
    expect(words(html)).toContain("Show older");
  });

  it("is drawn under the empty state of a log whose newest events are none, since older work may hold some", async () => {
    const html = draw({ load: { kind: "ready", value: { events: [], keptMonths: null, older: "more" } }, older: view("more") });
    expect(html).toContain('data-testid="act-empty"');
    expect(html.indexOf('data-testid="act-empty"')).toBeLessThan(html.indexOf('data-testid="older"'));
    expect(html).toContain('data-testid="older-show"');
  });

  it("is drawn when the filters leave no event, and says everything is shown once the last page is read", async () => {
    const log = await demoLog();
    const hidden = draw({ load: { kind: "ready", value: log }, older: view("end") }, { query: "no event says this" });
    expect(hidden).toContain('data-testid="act-none"');
    expect(hidden.indexOf('data-testid="act-none"')).toBeLessThan(hidden.indexOf('data-testid="older"'));
    expect(words(hidden)).toContain("That is everything. There is no older work.");
    expect(hidden).not.toContain('data-testid="older-show"');
  });

  it("is not drawn for a list that says nothing, as Practice's never does, nor while the log loads", async () => {
    const log = await demoLog();
    expect(log).not.toHaveProperty("older");
    expect(draw({ load: { kind: "ready", value: log } })).not.toContain('data-testid="older');
    expect(draw({ load: LOADING })).not.toContain('data-testid="older');
    expect(draw({ load: { kind: "unavailable", code: "not_yet", message: "Not yet" } })).not.toContain('data-testid="older');
  });
});

describe("pressing Show older", () => {
  /** A press whose parts a test holds: what it set, how often the page read its list again, and when the answer comes. */
  function press(ask: () => Promise<unknown>, alive = () => true) {
    const said: OlderUi[] = [];
    const log = { reads: 0 };
    const go = olderPress({ ask, set: (ui) => said.push(ui), after: () => (log.reads += 1), alive });
    return { go, said, log };
  }
  const refused = (code: string, message: string): BridgeError => ({ code, message }) as BridgeError;

  it("asks for the next page, and once it is read has the page read its list again", async () => {
    const ask = vi.fn(async () => ({ older: "more" }));
    const { go, said, log } = press(ask);
    await go();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(said).toEqual([reading, OLDER_IDLE]);
    expect(log.reads).toBe(1);
  });

  it("says why in the runtime's own words when the page was not read, reads nothing again, and presses again from there", async () => {
    let answer: () => Promise<unknown> = async () => {
      throw refused("offline", t("older.offline"));
    };
    const { go, said, log } = press(() => answer());
    await go();
    expect(said).toEqual([reading, failed(t("older.offline"))]);
    expect(log.reads).toBe(0);
    // Try again
    answer = async () => ({ older: "end" });
    await go();
    expect(said.slice(2)).toEqual([reading, OLDER_IDLE]);
    expect(log.reads).toBe(1);
    // a failure that is not the runtime's refusal still says something, in the page's own words
    answer = async () => {
      throw new Error("boom");
    };
    await go();
    expect(said.at(-1)).toEqual(failed("boom"));
    expect(olderWords("more", said.at(-1)!).alert).toBe(true);
  });

  it("is one press at a time: a press while one is on its way does nothing", async () => {
    let finish!: () => void;
    const ask = vi.fn(() => new Promise<unknown>((resolve) => (finish = () => resolve({ older: "more" }))));
    const { go, said, log } = press(ask);
    const first = go();
    await go();
    await go();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(said).toEqual([reading]);
    finish();
    await first;
    expect(said).toEqual([reading, OLDER_IDLE]);
    expect(log.reads).toBe(1);
    // and the next press is its own
    const second = go();
    expect(ask).toHaveBeenCalledTimes(2);
    finish();
    await second;
    expect(log.reads).toBe(2);
  });

  it("does nothing to a page that has gone by the time the answer comes", async () => {
    let here = true;
    let finish!: () => void;
    const { go, said, log } = press(() => new Promise<unknown>((resolve) => (finish = () => resolve({ older: "more" }))), () => here);
    const pressed = go();
    here = false;
    finish();
    await pressed;
    expect(said).toEqual([reading]);
    expect(log.reads).toBe(0);
  });
});
